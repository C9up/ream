//! Hyper HTTP server implementation.
//!
//! @implements FR23

use crate::request::ReamRequest;
use crate::response::ReamResponse;
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

/// Handler function type — receives a ReamRequest, returns a ReamResponse.
pub type RequestHandler = Arc<dyn Fn(ReamRequest) -> std::pin::Pin<Box<dyn Future<Output = ReamResponse> + Send>> + Send + Sync>;

/// Hyper-based HTTP server for the Ream framework.
pub struct ReamServer {
    host: [u8; 4],
    port: u16,
    handler: Option<RequestHandler>,
    security_filter: Option<Arc<dyn crate::SecurityFilter>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    actual_port: Arc<Mutex<u16>>,
}

impl ReamServer {
    /// Create a new server bound to 127.0.0.1 on the given port (0 for random).
    pub fn new(port: u16) -> Self {
        Self {
            host: [127, 0, 0, 1],
            port,
            handler: None,
            security_filter: None,
            shutdown_tx: None,
            actual_port: Arc::new(Mutex::new(0)),
        }
    }

    /// Set the bind address (e.g., [0, 0, 0, 0] for all interfaces).
    pub fn with_host(mut self, host: [u8; 4]) -> Self {
        self.host = host;
        self
    }

    /// Set the security filter (Blackhole). Optional — server works without one.
    pub fn set_security_filter(&mut self, filter: Arc<dyn crate::SecurityFilter>) {
        self.security_filter = Some(filter);
    }

    /// Register the request handler.
    pub fn on_request(&mut self, handler: RequestHandler) {
        self.handler = Some(handler);
    }

    /// Get the actual bound port (useful when port=0).
    pub async fn actual_port(&self) -> u16 {
        *self.actual_port.lock().await
    }

    /// Start listening for HTTP connections.
    ///
    /// Returns a Future that resolves when the server is ready to accept connections.
    pub async fn listen(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let handler = self.handler.clone().ok_or("No request handler registered")?;
        let security_filter = self.security_filter.clone();

        let addr = SocketAddr::from((self.host, self.port));
        let listener = TcpListener::bind(addr).await?;
        let local_addr = listener.local_addr()?;

        {
            let mut port = self.actual_port.lock().await;
            *port = local_addr.port();
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let actual_port = self.actual_port.clone();

        tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;

            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((stream, _addr)) => {
                                let handler = handler.clone();
                                let filter = security_filter.clone();
                                let io = hyper_util::rt::TokioIo::new(stream);

                                tokio::spawn(async move {
                                    let service = service_fn(move |req: Request<Incoming>| {
                                        let handler = handler.clone();
                                        let filter = filter.clone();
                                        async move {
                                            let ream_req = hyper_to_ream_request(req).await;

                                            // Security filter check BEFORE NAPI crossing
                                            let ream_req = if let Some(ref filter) = filter {
                                                match filter.check(ream_req) {
                                                    crate::FilterResult::Allow(req) => req,
                                                    crate::FilterResult::Sanitized(req) => req,
                                                    crate::FilterResult::Reject(res) => {
                                                        // Rejected — return directly from Rust, no NAPI crossing
                                                        return ream_response_to_hyper(res);
                                                    }
                                                }
                                            } else {
                                                ream_req
                                            };

                                            let ream_res = (handler)(ream_req).await;
                                            ream_response_to_hyper(ream_res)
                                        }
                                    });

                                    if let Err(_e) = http1::Builder::new()
                                        .serve_connection(io, service)
                                        .await
                                    {
                                        // Connection error — client disconnected, etc.
                                    }
                                });
                            }
                            Err(_e) => {
                                // Accept error — continue listening
                            }
                        }
                    }
                    _ = &mut shutdown_rx => {
                        // Shutdown signal received
                        let mut port = actual_port.lock().await;
                        *port = 0;
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    /// Gracefully shut down the server.
    pub fn close(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Convert a hyper Request to a ReamRequest.
async fn hyper_to_ream_request(req: Request<Incoming>) -> ReamRequest {
    let method = req.method().to_string();
    let uri = req.uri().to_string();

    let mut headers = HashMap::new();
    for (name, value) in req.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(name.to_string(), v.to_string());
        }
    }

    let body_bytes = http_body_util::BodyExt::collect(req.into_body())
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();

    let body = String::from_utf8_lossy(&body_bytes).to_string();

    ReamRequest::from_hyper(&method, &uri, headers, body)
}

/// Convert a ReamResponse to a hyper Response.
/// Returns a 500 fallback if the response contains invalid data (bad status, bad headers).
fn ream_response_to_hyper(
    ream_res: ReamResponse,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    // Validate status code (100-599)
    let status = if (100..=599).contains(&ream_res.status) {
        ream_res.status
    } else {
        500
    };

    let mut builder = Response::builder().status(status);

    for (name, value) in &ream_res.headers {
        // Skip invalid header names/values instead of panicking
        if let (Ok(_), Ok(_)) = (
            hyper::header::HeaderName::from_bytes(name.as_bytes()),
            hyper::header::HeaderValue::from_str(value),
        ) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }

    match builder.body(Full::new(Bytes::from(ream_res.body))) {
        Ok(response) => Ok(response),
        Err(_) => {
            // Fallback: plain 500 response if builder fails
            Ok(Response::builder()
                .status(500)
                .body(Full::new(Bytes::from("Internal Server Error")))
                .expect("fallback response must be valid"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_server_starts_and_closes() {
        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(|_req| {
            Box::pin(async { ReamResponse::text(200, "ok") })
        }));
        server.listen().await.unwrap();
        let port = server.actual_port().await;
        assert!(port > 0);
        server.close();
    }

    #[tokio::test]
    async fn test_server_handles_request() {
        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(|req| {
            Box::pin(async move {
                ReamResponse::text(200, format!("Hello from {}", req.path))
            })
        }));
        server.listen().await.unwrap();
        let port = server.actual_port().await;

        // Make a request using tokio TcpStream + HTTP manually
        let response = reqwest_like_get(port, "/test").await;
        assert_eq!(response, "Hello from /test");

        server.close();
    }

    #[tokio::test]
    async fn test_server_with_security_filter_rejects() {
        use crate::security::{FilterResult, SecurityFilter};

        // Create a filter that rejects all POST requests
        struct RejectPostFilter;
        impl SecurityFilter for RejectPostFilter {
            fn check(&self, request: ReamRequest) -> FilterResult {
                if request.method == "POST" {
                    FilterResult::Reject(ReamResponse::json(403, r#"{"error":"blocked"}"#))
                } else {
                    FilterResult::Allow(request)
                }
            }
        }

        let mut server = ReamServer::new(0);
        server.set_security_filter(Arc::new(RejectPostFilter));
        server.on_request(Arc::new(|_req| {
            Box::pin(async { ReamResponse::text(200, "should not reach here") })
        }));
        server.listen().await.unwrap();
        let port = server.actual_port().await;

        // GET should pass through
        let get_response = reqwest_like_get(port, "/test").await;
        assert_eq!(get_response, "should not reach here");

        // POST should be rejected by filter — never reaches handler
        let post_response = reqwest_like_post(port, "/test", "body").await;
        assert!(post_response.contains("blocked"));

        server.close();
    }

    #[tokio::test]
    async fn test_server_without_security_filter() {
        // Server works fine without a security filter (NoopFilter behavior)
        let mut server = ReamServer::new(0);
        // No security filter set
        server.on_request(Arc::new(|_req| {
            Box::pin(async { ReamResponse::text(200, "no filter") })
        }));
        server.listen().await.unwrap();
        let port = server.actual_port().await;

        let response = reqwest_like_get(port, "/test").await;
        assert_eq!(response, "no filter");

        server.close();
    }

    /// Simple HTTP GET using raw TCP (no external deps needed).
    async fn reqwest_like_get(port: u16, path: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))
            .await
            .unwrap();

        let request = format!(
            "GET {} HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n",
            path, port
        );
        stream.write_all(request.as_bytes()).await.unwrap();

        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();

        // Extract body after the double CRLF
        response
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or("")
            .to_string()
    }

    async fn reqwest_like_post(port: u16, path: &str, body: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpStream;

        let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))
            .await
            .unwrap();

        let request = format!(
            "POST {} HTTP/1.1\r\nHost: localhost:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            path, port, body.len(), body
        );
        stream.write_all(request.as_bytes()).await.unwrap();

        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();

        response
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or("")
            .to_string()
    }
}

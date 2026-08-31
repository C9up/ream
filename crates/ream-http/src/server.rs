//! Hyper HTTP server implementation.
//!
//! @implements FR23

use crate::request::ReamRequest;
use crate::response::ReamResponse;
use crate::stream_registry::StreamRegistry;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioExecutor;
use hyper_util::server::conn::auto::Builder as AutoBuilder;
use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Mutex};
use tokio_stream::wrappers::ReceiverStream;

/// Unified body type for hyper responses: either a fully buffered payload
/// (the common request/response case) or a streamed sequence of frames
/// (SSE, chunked downloads). Boxing both behind a single `BoxBody` lets
/// `service_fn` keep a single return type.
pub type ResponseBody = BoxBody<Bytes, Infallible>;

/// Handler function type — receives a ReamRequest, returns a ReamResponse.
pub type RequestHandler = Arc<
    dyn Fn(ReamRequest) -> std::pin::Pin<Box<dyn Future<Output = ReamResponse> + Send>>
        + Send
        + Sync,
>;

/// Optional response filter applied after the handler returns, before Hyper sends.
pub type ResponseFilter = Arc<dyn Fn(ReamResponse) -> ReamResponse + Send + Sync>;

/// Hyper-based HTTP server for the Ream framework.
pub struct ReamServer {
    host: [u8; 4],
    port: u16,
    handler: Option<RequestHandler>,
    security_filter: Option<Arc<dyn crate::SecurityFilter>>,
    response_filter: Option<ResponseFilter>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// Accept-loop task handle. Held so `shutdown()` can AWAIT the loop's end —
    /// the loop owns a clone of the request handler, which (in the NAPI layer)
    /// captures the JS `ThreadsafeFunction`. Dropping the loop is what lets that
    /// tsfn's refcount fall to zero; without awaiting it here, an in-process
    /// host (test harness) keeps a live libuv handle and never drains.
    accept_handle: Option<tokio::task::JoinHandle<()>>,
    /// Broadcasts a wind-down signal to every in-flight connection task on
    /// shutdown. Idle keep-alive connections close, in-flight requests finish,
    /// and SSE bodies (EOF'd via the registry drain) complete — so the detached
    /// connection tasks end, drop their handler clones, and release the
    /// libuv/tsfn handle that otherwise keeps a Node host's event loop alive
    /// (the watcher then sees the child exit instead of force-killing it).
    conn_shutdown_tx: Option<watch::Sender<bool>>,
    actual_port: Arc<Mutex<u16>>,
    /// CIDR ranges (or bare IPs) of proxies whose `X-Forwarded-For` is honoured.
    /// Empty = strict fail-closed (proxy headers ignored entirely; only the
    /// socket peer is used). Use the `"*"` sentinel to opt into permissive
    /// mode for deployments that can't enumerate proxy CIDRs.
    trusted_proxies: Arc<Vec<String>>,
    rate_limiter: Option<Arc<crate::RateLimiter>>,
    /// Stream registry — populated by JS via NAPI when the handler upgrades
    /// the response to streaming mode (SSE etc.). Always cloned out into the
    /// per-connection task so handlers / NAPI keep a coherent view.
    stream_registry: StreamRegistry,
}

impl ReamServer {
    /// Create a new server bound to 127.0.0.1 on the given port (0 for random).
    pub fn new(port: u16) -> Self {
        Self {
            host: [127, 0, 0, 1],
            port,
            handler: None,
            security_filter: None,
            response_filter: None,
            shutdown_tx: None,
            accept_handle: None,
            conn_shutdown_tx: None,
            actual_port: Arc::new(Mutex::new(0)),
            trusted_proxies: Arc::new(Vec::new()),
            rate_limiter: None,
            stream_registry: StreamRegistry::new(),
        }
    }

    /// Hand out the shared stream registry. The NAPI layer needs this so
    /// JS-side `writeStream(id, …)` calls land on the same map the
    /// response builder reads from.
    pub fn stream_registry(&self) -> StreamRegistry {
        self.stream_registry.clone()
    }

    /// Replace the stream registry with an externally-owned one. Used by
    /// the NAPI layer so registrations made through `HyperServer` before
    /// `listen()` survive into the request-serving phase.
    pub fn set_stream_registry(&mut self, registry: StreamRegistry) {
        self.stream_registry = registry;
    }

    /// Install an in-process rate limiter. Set to `None` (default) to skip
    /// rate limiting entirely.
    pub fn set_rate_limiter(&mut self, limiter: Option<Arc<crate::RateLimiter>>) {
        self.rate_limiter = limiter;
    }

    /// Configure the trusted-proxy CIDR list used by `request.ip` resolution.
    /// When empty, `X-Forwarded-For` is honoured unconditionally (legacy
    /// permissive default). Apps that face the public internet should set
    /// this to the LB / CDN ranges they sit behind.
    pub fn set_trusted_proxies(&mut self, proxies: Vec<String>) {
        self.trusted_proxies = Arc::new(proxies);
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

    /// Set a response filter applied after the handler, before Hyper sends.
    /// Used for XSS sanitization of HTML/text responses.
    pub fn set_response_filter(&mut self, filter: ResponseFilter) {
        self.response_filter = Some(filter);
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
        let handler = self
            .handler
            .clone()
            .ok_or("No request handler registered")?;
        let security_filter = self.security_filter.clone();
        let response_filter = self.response_filter.clone();
        let trusted_proxies = self.trusted_proxies.clone();
        let rate_limiter = self.rate_limiter.clone();
        let stream_registry = self.stream_registry.clone();

        let addr = SocketAddr::from((self.host, self.port));
        let listener = TcpListener::bind(addr).await?;
        let local_addr = listener.local_addr()?;

        {
            let mut port = self.actual_port.lock().await;
            *port = local_addr.port();
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        let (conn_shutdown_tx, conn_shutdown_rx) = watch::channel(false);
        self.conn_shutdown_tx = Some(conn_shutdown_tx);

        let actual_port = self.actual_port.clone();

        self.accept_handle = Some(tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;

            loop {
                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((stream, peer_addr)) => {
                                let handler = handler.clone();
                                let filter = security_filter.clone();
                                let io = hyper_util::rt::TokioIo::new(stream);
                                let peer_ip = peer_addr.ip().to_string();
                                let trusted = trusted_proxies.clone();
                                let limiter = rate_limiter.clone();
                                let registry = stream_registry.clone();

                                let res_filter = response_filter.clone();
                                let mut conn_shutdown = conn_shutdown_rx.clone();
                                tokio::spawn(async move {
                                    let service = service_fn(move |req: Request<Incoming>| {
                                        let handler = handler.clone();
                                        let filter = filter.clone();
                                        let res_filter = res_filter.clone();
                                        let peer_ip = peer_ip.clone();
                                        let trusted = trusted.clone();
                                        let limiter = limiter.clone();
                                        let registry = registry.clone();
                                        async move {
                                            let ream_req = match hyper_to_ream_request(req, peer_ip, &trusted).await {
                                                Ok(r) => r,
                                                Err(res) => {
                                                    // Body too large — return 413 from Rust, no NAPI crossing.
                                                    return build_hyper_response(res, &registry).await;
                                                }
                                            };

                                            // Security filter check BEFORE NAPI crossing
                                            let ream_req = if let Some(ref filter) = filter {
                                                match filter.check(ream_req) {
                                                    crate::FilterResult::Allow(req) => req,
                                                    crate::FilterResult::Sanitized(req) => req,
                                                    crate::FilterResult::Reject(res) => {
                                                        // Rejected — return directly from Rust, no NAPI crossing
                                                        return build_hyper_response(res, &registry).await;
                                                    }
                                                }
                                            } else {
                                                ream_req
                                            };

                                            // Rate limit BEFORE NAPI crossing — blocked requests
                                            // never pay the JS dispatch cost. The outcome is
                                            // also stitched into the eventual response headers.
                                            let rate_outcome = limiter.as_ref().map(|l| {
                                                l.check(&ream_req.ip)
                                            });
                                            if let Some(outcome) = rate_outcome {
                                                if !outcome.allowed {
                                                    return build_hyper_response(
                                                        rate_limited_response(outcome),
                                                        &registry,
                                                    )
                                                    .await;
                                                }
                                            }

                                            let mut ream_res = (handler)(ream_req).await;

                                            // Apply response filter (XSS sanitization for
                                            // HTML/text) — skipped for streamed bodies. A
                                            // sanitizer that scans an SSE wire (`event:
                                            // foo\ndata: bar\n\n`) would butcher the framing.
                                            if !ream_res.is_streaming() {
                                                if let Some(ref rf) = res_filter {
                                                    ream_res = (rf)(ream_res);
                                                }
                                            }

                                            // Stitch rate-limit headers onto allowed responses
                                            // so well-behaved clients can self-throttle.
                                            if let Some(outcome) = rate_outcome {
                                                attach_rate_limit_headers(&mut ream_res, outcome);
                                            }

                                            build_hyper_response(ream_res, &registry).await
                                        }
                                    });

                                    // Auto-detect HTTP/1.1 vs HTTP/2 via ALPN
                                    // (HTTP/2 requires TLS with ALPN negotiation;
                                    // plain TCP falls back to HTTP/1.1 which is correct).
                                    let builder = AutoBuilder::new(TokioExecutor::new());
                                    let conn = builder.serve_connection(io, service);
                                    tokio::pin!(conn);
                                    tokio::select! {
                                        res = conn.as_mut() => {
                                            if let Err(_e) = res {
                                                // Connection error — client disconnected, etc.
                                            }
                                        }
                                        _ = conn_shutdown.changed() => {
                                            // Server is shutting down: ask the connection to
                                            // wind down (finish any in-flight request, stop
                                            // reading new ones), then await its end. SSE bodies
                                            // were EOF'd by the registry drain, so they finish
                                            // here too — the task ends and drops its handler
                                            // clone, releasing the tsfn that pins Node's loop.
                                            conn.as_mut().graceful_shutdown();
                                            let _ = conn.as_mut().await;
                                        }
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
        }));

        Ok(())
    }

    /// Gracefully shut down the server (fire-and-forget). Signals the accept
    /// loop to stop but does NOT await it — kept for tests / callers that don't
    /// need a deterministic teardown. Prefer `shutdown()` for in-process hosts.
    pub fn close(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(tx) = self.conn_shutdown_tx.take() {
            let _ = tx.send(true);
        }
    }

    /// Graceful async shutdown: signal the accept loop AND await its end, so the
    /// loop's clone of the request handler is dropped before this returns. In
    /// the NAPI layer the handler captures the JS `ThreadsafeFunction`; pairing
    /// this with clearing the NAPI-side handler reference drops the tsfn's
    /// refcount to zero, letting napi-rs release the libuv handle so an
    /// in-process host (e.g. a test harness) can drain its event loop.
    pub async fn shutdown(&mut self) {
        // Stop accepting new connections.
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        // EOF every live SSE/streamed body so its connection can finish...
        self.stream_registry.drain().await;
        // ...then tell all in-flight connections to wind down.
        if let Some(tx) = self.conn_shutdown_tx.take() {
            let _ = tx.send(true);
        }
        // Await the accept loop's end (drops its handler clone).
        if let Some(handle) = self.accept_handle.take() {
            let _ = handle.await;
        }
    }
}

/// Build the 429 response for a blocked rate-limit outcome. Includes the
/// `Retry-After` and `X-RateLimit-*` headers RFC 6585 / draft-ietf clients
/// expect.
fn rate_limited_response(outcome: crate::RateLimitOutcome) -> ReamResponse {
    let reset_secs = outcome.reset_in.as_secs().max(1);
    let body = format!(
        r#"{{"error":{{"code":"E_TOO_MANY_REQUESTS","message":"Too many requests","retryAfter":{reset_secs}}}}}"#
    );
    let mut res = ReamResponse::json(429, body);
    res.headers
        .insert("retry-after".into(), reset_secs.to_string());
    res.headers
        .insert("x-ratelimit-limit".into(), outcome.limit.to_string());
    res.headers.insert(
        "x-ratelimit-remaining".into(),
        outcome.remaining.to_string(),
    );
    res.headers
        .insert("x-ratelimit-reset".into(), reset_secs.to_string());
    res
}

/// Append `X-RateLimit-*` headers to an allowed response so clients can see
/// how many calls they have left in the current window.
fn attach_rate_limit_headers(response: &mut ReamResponse, outcome: crate::RateLimitOutcome) {
    let reset_secs = outcome.reset_in.as_secs().max(1);
    response
        .headers
        .insert("x-ratelimit-limit".into(), outcome.limit.to_string());
    response.headers.insert(
        "x-ratelimit-remaining".into(),
        outcome.remaining.to_string(),
    );
    response
        .headers
        .insert("x-ratelimit-reset".into(), reset_secs.to_string());
}

/// Convert a hyper Request to a ReamRequest, including the TCP peer IP and
/// the resolved client IP (per the configured trusted-proxy CIDR list).
async fn hyper_to_ream_request(
    req: Request<Incoming>,
    peer_ip: String,
    trusted_proxies: &[String],
) -> Result<ReamRequest, ReamResponse> {
    let method = req.method().to_string();
    let uri = req.uri().to_string();

    let mut headers = HashMap::new();
    for (name, value) in req.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(name.to_string(), v.to_string());
        }
    }

    // Hard body size limit at the Rust layer — prevents OOM before NAPI crossing.
    // The TS BodyParserMiddleware enforces per-content-type limits, but it operates
    // AFTER the body is already in memory. This is the last line of defense.
    // 100 MB should accommodate large file uploads; the TS layer enforces stricter
    // per-content-type limits (e.g., 1 MB for JSON).
    const MAX_BODY_BYTES: usize = 100 * 1024 * 1024;
    let limited = http_body_util::Limited::new(req.into_body(), MAX_BODY_BYTES);
    let (body_bytes, oversized) = match http_body_util::BodyExt::collect(limited).await {
        Ok(collected) => (collected.to_bytes(), false),
        Err(_) => (bytes::Bytes::new(), true),
    };

    // Reject oversized bodies with a proper 413 — never hand an empty body
    // to the TS layer where it would produce a misleading 400 parse error.
    if oversized {
        return Err(ReamResponse::json(
            413,
            r#"{"error":{"code":"E_PAYLOAD_TOO_LARGE","message":"Request body exceeds the 100 MB server limit"}}"#,
        ));
    }

    let resolved_ip = crate::ip::resolve_client_ip(&peer_ip, &headers, trusted_proxies);
    let cookie_header = headers.get("cookie").cloned().unwrap_or_default();
    let cookies = crate::cookies::parse_cookie_header(&cookie_header);
    let content_type = headers.get("content-type").cloned().unwrap_or_default();

    // Multipart: parse server-side via `multer`. Ship structured fields/files
    // to JS instead of the raw boundary-framed bytes. JS no longer parses.
    if content_type.starts_with("multipart/form-data") {
        let payload = match crate::multipart::extract_boundary(&content_type) {
            Some(boundary) => {
                match crate::multipart::parse_multipart(&boundary, body_bytes).await {
                    Ok(p) => Some(p),
                    Err(_) => {
                        return Err(ReamResponse::json(
                            400,
                            r#"{"error":{"code":"E_BAD_MULTIPART","message":"Malformed multipart/form-data body"}}"#,
                        ));
                    }
                }
            }
            None => {
                return Err(ReamResponse::json(
                    400,
                    r#"{"error":{"code":"E_BAD_MULTIPART","message":"multipart/form-data missing boundary parameter"}}"#,
                ));
            }
        };
        let mut req =
            ReamRequest::from_hyper_with_addr(&method, &uri, headers, String::new(), peer_ip);
        req.body_encoding = "multipart".to_string();
        req.ip = resolved_ip;
        req.multipart = payload;
        req.cookies = cookies;
        return Ok(req);
    }

    // Other binary content (`application/octet-stream`, etc.) still rides as
    // base64 — JS layer decodes via `Request.rawBuffer()`.
    let is_binary = content_type.starts_with("application/octet-stream");
    if is_binary {
        use base64::Engine;
        let body = base64::engine::general_purpose::STANDARD.encode(&body_bytes);
        let mut req = ReamRequest::from_hyper_with_addr(&method, &uri, headers, body, peer_ip);
        req.body_encoding = "base64".to_string();
        req.ip = resolved_ip;
        req.cookies = cookies;
        Ok(req)
    } else {
        let body = String::from_utf8_lossy(&body_bytes).to_string();
        let mut req = ReamRequest::from_hyper_with_addr(&method, &uri, headers, body, peer_ip);
        req.ip = resolved_ip;
        req.cookies = cookies;
        Ok(req)
    }
}

/// Convert a `ReamResponse` to a hyper response. Dispatches between the
/// fully-buffered path (the common case) and the streaming path (SSE
/// etc.) based on `ream_res.stream_id`.
///
/// Always succeeds — falls back to a 500 with an `Internal Server
/// Error` body if response construction trips (invalid status,
/// unmappable header), so the connection task never bubbles a `hyper`
/// error.
async fn build_hyper_response(
    ream_res: ReamResponse,
    registry: &StreamRegistry,
) -> Result<Response<ResponseBody>, hyper::Error> {
    if ream_res.stream_id.is_some() {
        Ok(build_streaming_response(ream_res, registry).await)
    } else {
        Ok(build_buffered_response(ream_res))
    }
}

/// Build a `Response<ResponseBody>` from a fully buffered `ReamResponse`.
fn build_buffered_response(ream_res: ReamResponse) -> Response<ResponseBody> {
    let status = if (100..=599).contains(&ream_res.status) {
        ream_res.status
    } else {
        500
    };

    let mut builder = Response::builder().status(status);
    builder = apply_headers(builder, &ream_res.headers);

    // Decode base64 body when x-ream-body-encoding: base64 is set (sendBuffer path).
    // The TS Response.sendBuffer() base64-encodes binary content so it survives JSON
    // serialization across the NAPI boundary. We decode it back here before writing
    // to the socket so the client receives the original bytes (PNG, PDF, etc.).
    let body_bytes = if ream_res
        .headers
        .get("x-ream-body-encoding")
        .map(|v| v == "base64")
        .unwrap_or(false)
    {
        use base64::Engine;
        match base64::engine::general_purpose::STANDARD.decode(&ream_res.body) {
            Ok(decoded) => Bytes::from(decoded),
            Err(_) => Bytes::from(ream_res.body), // fallback: send as-is if decode fails
        }
    } else {
        Bytes::from(ream_res.body)
    };

    let body: ResponseBody = Full::new(body_bytes).boxed();
    builder.body(body).unwrap_or_else(|_| {
        Response::builder()
            .status(500)
            .body(Full::new(Bytes::from("Internal Server Error")).boxed())
            .expect("fallback response must be valid")
    })
}

/// Build a streaming response: take the matching mpsc receiver out of the
/// registry, wrap it in `StreamBody`, and return. Hyper polls the body
/// asynchronously as JS pushes chunks over NAPI.
async fn build_streaming_response(
    ream_res: ReamResponse,
    registry: &StreamRegistry,
) -> Response<ResponseBody> {
    let status = if (100..=599).contains(&ream_res.status) {
        ream_res.status
    } else {
        500
    };

    let stream_id = ream_res
        .stream_id
        .as_deref()
        .expect("build_streaming_response called without stream_id");

    let Some(receiver) = registry.take_receiver(stream_id).await else {
        // JS shipped a stream_id we don't know about. Could be a race
        // (register / response built twice) or a buggy handler. 500
        // with a JSON error gives operators a clear signal.
        return Response::builder()
            .status(500)
            .header("content-type", "application/json")
            .body(
                Full::new(Bytes::from(
                    r#"{"error":{"code":"E_STREAM_UNKNOWN","message":"Unknown streamId"}}"#,
                ))
                .boxed(),
            )
            .expect("fallback response must be valid");
    };

    let mut builder = Response::builder().status(status);
    builder = apply_headers(builder, &ream_res.headers);

    // SSE-friendly defaults: never cache, never let an intermediary
    // (e.g. Nginx) buffer the stream. Callers can override either by
    // setting the same headers on the JS side — `apply_headers` already
    // ran, but our defaults only set the values if the header was not
    // provided.
    let has_cache_control = ream_res
        .headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("cache-control"));
    if !has_cache_control {
        builder = builder.header("cache-control", "no-cache, no-transform");
    }
    let has_xacc = ream_res
        .headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("x-accel-buffering"));
    if !has_xacc {
        builder = builder.header("x-accel-buffering", "no");
    }

    let stream = ReceiverStream::new(receiver)
        .map(|chunk| Ok::<Frame<Bytes>, Infallible>(Frame::data(chunk.bytes)));
    let body: ResponseBody = BodyExt::boxed(StreamBody::new(stream));
    builder.body(body).unwrap_or_else(|_| {
        Response::builder()
            .status(500)
            .body(Full::new(Bytes::from("Internal Server Error")).boxed())
            .expect("fallback response must be valid")
    })
}

/// Apply a TS-side header map to a hyper `Response::Builder`. Shared
/// between the buffered and streaming paths so cookie splitting and
/// internal-header stripping stay in one place.
fn apply_headers(
    mut builder: hyper::http::response::Builder,
    headers: &HashMap<String, String>,
) -> hyper::http::response::Builder {
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("set-cookie") {
            for cookie in value.split('\n').filter(|v| !v.is_empty()) {
                if let (Ok(_), Ok(_)) = (
                    hyper::header::HeaderName::from_bytes(name.as_bytes()),
                    hyper::header::HeaderValue::from_str(cookie),
                ) {
                    builder = builder.header(name.as_str(), cookie);
                }
            }
            continue;
        }

        if name == "x-ream-body-encoding" {
            continue;
        }

        if let (Ok(_), Ok(_)) = (
            hyper::header::HeaderName::from_bytes(name.as_bytes()),
            hyper::header::HeaderValue::from_str(value),
        ) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }
    builder
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
    async fn shutdown_closes_idle_keep_alive_connections() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(|_req| {
            Box::pin(async { ReamResponse::text(200, "ok") })
        }));
        server.listen().await.unwrap();
        let port = server.actual_port().await;

        // Open a keep-alive connection and complete one request, leaving the
        // socket idle — the connection task is now parked in serve_connection
        // waiting for the next request (the case that pins Node's event loop).
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream
            .write_all(b"GET /x HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "should get a response");

        // Shutting down must close the idle keep-alive connection rather than
        // leave it dangling. Before the conn-cancel fix, shutdown() only stopped
        // the accept loop and this socket stayed open forever.
        server.shutdown().await;

        // Server side closed the socket → the next read returns EOF (0 bytes).
        let n2 = stream.read(&mut buf).await.unwrap();
        assert_eq!(n2, 0, "server must close idle keep-alive on shutdown");
    }

    #[tokio::test]
    async fn test_server_handles_request() {
        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(|req| {
            Box::pin(async move { ReamResponse::text(200, format!("Hello from {}", req.path)) })
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

    #[test]
    fn test_set_cookie_newline_is_split_into_multiple_headers() {
        let mut headers = HashMap::new();
        headers.insert(
            "set-cookie".to_string(),
            "a=1; Path=/\nb=2; Path=/".to_string(),
        );

        let ream_res = ReamResponse {
            status: 200,
            headers,
            body: String::new(),
            stream_id: None,
        };

        let hyper_res = build_buffered_response(ream_res);
        let values = hyper_res.headers().get_all("set-cookie");
        assert_eq!(values.iter().count(), 2);
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
        response.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
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

        response.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
    }
}

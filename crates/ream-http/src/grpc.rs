//! gRPC on the HTTP port.
//!
//! A request whose content-type is `application/grpc*` goes to tonic instead
//! of the collect-then-dispatch HTTP path — but only once a gRPC handler is
//! registered; without one it stays an ordinary HTTP request. tonic owns the
//! framing, the status and the trailers. The message bytes pass through
//! untouched to the handler, which decodes them: this crate knows nothing
//! about protobuf.
//!
//! The branch sits before the body is collected, which is where the HTTP path
//! runs its rate limiter and security filter. So it runs them itself, on the
//! headers, before tonic reads a byte of the message — a call they refuse
//! never reaches the handler. The message is bounded by tonic's decode limit
//! (4 MiB by default), not by the HTTP path's 100 MB.

use crate::ratelimit::RateLimiter;
use crate::request::ReamRequest;
use crate::security::{FilterResult, SecurityFilter};
use bytes::{Buf, BufMut, Bytes};
use hyper::body::Incoming;
use hyper::{Request, Response};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::server::{Grpc, UnaryService};
use tonic::{Code, Status};

/// One unary call, as the handler receives it.
pub struct GrpcCall {
    /// `/package.Service/Method`, as it arrived.
    pub path: String,
    /// Request metadata (header names lowercased). Values that are not
    /// visible ASCII are left out.
    pub metadata: HashMap<String, String>,
    /// The request message, still encoded.
    pub message: Bytes,
    /// Resolved client IP, by the same trusted-proxy rules as `request.ip`.
    pub ip: String,
}

/// What the handler answers.
pub enum GrpcReply {
    /// The reply message, already encoded.
    Message(Bytes),
    /// A gRPC status instead of a reply. `code` is a gRPC status code; an
    /// unknown one (or `0`, which is not an error) is answered as `UNKNOWN`.
    Status { code: i32, details: String },
}

/// The gRPC handler — in the NAPI layer, a JS function.
pub type GrpcHandler =
    Arc<dyn Fn(GrpcCall) -> Pin<Box<dyn Future<Output = GrpcReply> + Send>> + Send + Sync>;

/// Whether the request is a gRPC call (`application/grpc`, `+proto`, `+json`…).
pub fn is_grpc<B>(req: &Request<B>) -> bool {
    req.headers()
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/grpc"))
}

/// The protections the HTTP path applies, applied to a gRPC call.
pub(crate) struct Guards<'a> {
    pub peer_ip: &'a str,
    pub trusted_proxies: &'a [String],
    pub rate_limiter: Option<&'a Arc<RateLimiter>>,
    pub security_filter: Option<&'a Arc<dyn SecurityFilter>>,
}

/// Guard, then serve one gRPC call.
pub(crate) async fn serve(
    req: Request<Incoming>,
    handler: GrpcHandler,
    guards: Guards<'_>,
) -> Response<tonic::body::Body> {
    let headers: HashMap<String, String> = req
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    let ip = crate::ip::resolve_client_ip(guards.peer_ip, &headers, guards.trusted_proxies);

    if let Some(limiter) = guards.rate_limiter {
        if !limiter.check(&ip).allowed {
            return Status::resource_exhausted("Too many requests").into_http();
        }
    }

    if let Some(filter) = guards.security_filter {
        let mut probe = ReamRequest::from_hyper_with_addr(
            req.method().as_str(),
            &crate::server::origin_form(req.uri()),
            headers,
            String::new(),
            guards.peer_ip.to_string(),
        );
        probe.ip = ip.clone();
        if let FilterResult::Reject(rejection) = filter.check(probe) {
            return rejection_status(rejection.status).into_http();
        }
    }

    let path = req.uri().path().to_owned();
    Grpc::new(BytesCodec)
        .unary(Unary { path, ip, handler }, req)
        .await
}

/// The status a call the security filter refused is answered with.
fn rejection_status(http_status: u16) -> Status {
    let message = "Rejected by the security filter";
    match http_status {
        401 => Status::unauthenticated(message),
        403 => Status::permission_denied(message),
        429 => Status::resource_exhausted(message),
        _ => Status::invalid_argument(message),
    }
}

struct Unary {
    path: String,
    ip: String,
    handler: GrpcHandler,
}

impl UnaryService<Bytes> for Unary {
    type Response = Bytes;
    type Future = Pin<Box<dyn Future<Output = Result<tonic::Response<Bytes>, Status>> + Send>>;

    fn call(&mut self, request: tonic::Request<Bytes>) -> Self::Future {
        let metadata = request
            .metadata()
            .clone()
            .into_headers()
            .iter()
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
            .collect();
        let call = GrpcCall {
            path: self.path.clone(),
            metadata,
            message: request.into_inner(),
            ip: self.ip.clone(),
        };
        let reply = (self.handler)(call);
        Box::pin(async move {
            match reply.await {
                GrpcReply::Message(message) => Ok(tonic::Response::new(message)),
                GrpcReply::Status { code, details } => Err(Status::new(error_code(code), details)),
            }
        })
    }
}

fn error_code(code: i32) -> Code {
    match Code::from_i32(code) {
        Code::Ok => Code::Unknown,
        code => code,
    }
}

/// Passes message bytes through untouched; tonic still owns the 5-byte
/// length-prefixed framing around them.
#[derive(Clone, Copy, Default)]
struct BytesCodec;

struct BytesEncoder;
struct BytesDecoder;

impl Encoder for BytesEncoder {
    type Item = Bytes;
    type Error = Status;
    fn encode(&mut self, item: Bytes, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        dst.put(item);
        Ok(())
    }
}

impl Decoder for BytesDecoder {
    type Item = Bytes;
    type Error = Status;
    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Bytes>, Status> {
        Ok(Some(src.copy_to_bytes(src.remaining())))
    }
}

impl Codec for BytesCodec {
    type Encode = Bytes;
    type Decode = Bytes;
    type Encoder = BytesEncoder;
    type Decoder = BytesDecoder;
    fn encoder(&mut self) -> BytesEncoder {
        BytesEncoder
    }
    fn decoder(&mut self) -> BytesDecoder {
        BytesDecoder
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RateLimitConfig, ReamResponse, ReamServer};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tonic::codegen::http::uri::PathAndQuery;

    /// The handler under test: answers the message reversed, and records
    /// what it was given.
    fn recording_handler(seen: Arc<Mutex<Vec<GrpcCall>>>) -> GrpcHandler {
        Arc::new(move |call: GrpcCall| {
            let reply: Vec<u8> = call.message.iter().rev().copied().collect();
            seen.lock().unwrap().push(call);
            Box::pin(async move { GrpcReply::Message(Bytes::from(reply)) })
        })
    }

    async fn start(configure: impl FnOnce(&mut ReamServer)) -> (ReamServer, u16) {
        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(|req| {
            Box::pin(async move { ReamResponse::text(200, format!("http {}", req.path)) })
        }));
        configure(&mut server);
        server.listen().await.unwrap();
        let port = server.actual_port().await;
        (server, port)
    }

    async fn call(
        port: u16,
        path: &'static str,
        message: Bytes,
        metadata: &[(&'static str, &'static str)],
    ) -> Result<Bytes, Status> {
        let channel = tonic::transport::Endpoint::from_shared(format!("http://127.0.0.1:{port}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        let mut client = tonic::client::Grpc::new(channel);
        client.ready().await.unwrap();
        let mut request = tonic::Request::new(message);
        for (name, value) in metadata {
            request.metadata_mut().insert(*name, value.parse().unwrap());
        }
        client
            .unary(request, PathAndQuery::from_static(path), BytesCodec)
            .await
            .map(tonic::Response::into_inner)
    }

    async fn http_get(port: u16, path: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn grpc_and_http_share_the_port() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = recording_handler(seen.clone());
        let (mut server, port) = start(|s| s.on_grpc(handler)).await;

        let reply = call(port, "/t.S/M", Bytes::from_static(b"abc"), &[])
            .await
            .unwrap();
        assert_eq!(&reply[..], b"cba");
        assert!(http_get(port, "/page").await.ends_with("http /page"));

        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].path, "/t.S/M");
            assert_eq!(seen[0].ip, "127.0.0.1");
        }
        server.shutdown().await;
    }

    #[tokio::test]
    async fn metadata_reaches_the_handler() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = recording_handler(seen.clone());
        let (mut server, port) = start(|s| s.on_grpc(handler)).await;

        call(
            port,
            "/t.S/M",
            Bytes::new(),
            &[("authorization", "Bearer t0ken")],
        )
        .await
        .unwrap();
        {
            let seen = seen.lock().unwrap();
            assert_eq!(
                seen[0].metadata.get("authorization").map(String::as_str),
                Some("Bearer t0ken")
            );
        }
        server.shutdown().await;
    }

    #[tokio::test]
    async fn without_a_grpc_handler_the_request_stays_http() {
        let (mut server, port) = start(|_| {}).await;
        // The HTTP handler answers text/plain, which a gRPC client refuses —
        // what matters is that the call went down the unchanged HTTP path.
        let error = call(port, "/t.S/M", Bytes::new(), &[]).await.unwrap_err();
        assert_ne!(error.code(), Code::Ok);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_status_from_the_handler_reaches_the_client() {
        let (mut server, port) = start(|s| {
            s.on_grpc(Arc::new(|call: GrpcCall| {
                let code = if call.path.ends_with("/Ok") { 0 } else { 3 };
                Box::pin(async move {
                    GrpcReply::Status {
                        code,
                        details: "bad text".into(),
                    }
                })
            }))
        })
        .await;

        let error = call(port, "/t.S/M", Bytes::new(), &[]).await.unwrap_err();
        assert_eq!(error.code(), Code::InvalidArgument);
        assert_eq!(error.message(), "bad text");
        // `0` is not an error: a handler that answers it is answered UNKNOWN,
        // never a success without a message.
        let error = call(port, "/t.S/Ok", Bytes::new(), &[]).await.unwrap_err();
        assert_eq!(error.code(), Code::Unknown);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn the_rate_limiter_stops_a_call_before_the_handler() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = recording_handler(seen.clone());
        let (mut server, port) = start(|s| {
            s.on_grpc(handler);
            s.set_rate_limiter(Some(Arc::new(RateLimiter::new(RateLimitConfig {
                max: 1,
                window: Duration::from_secs(60),
            }))));
        })
        .await;

        call(port, "/t.S/M", Bytes::new(), &[]).await.unwrap();
        let error = call(port, "/t.S/M", Bytes::new(), &[]).await.unwrap_err();
        assert_eq!(error.code(), Code::ResourceExhausted);
        assert_eq!(seen.lock().unwrap().len(), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn the_security_filter_stops_a_call_before_the_handler() {
        struct RefuseForbidden;
        impl SecurityFilter for RefuseForbidden {
            fn check(&self, request: ReamRequest) -> FilterResult {
                if request.path.contains("Forbidden") {
                    FilterResult::Reject(ReamResponse::json(403, r#"{"error":"no"}"#))
                } else {
                    FilterResult::Allow(request)
                }
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = recording_handler(seen.clone());
        let (mut server, port) = start(|s| {
            s.on_grpc(handler);
            s.set_security_filter(Arc::new(RefuseForbidden));
        })
        .await;

        let error = call(port, "/t.S/Forbidden", Bytes::new(), &[])
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::PermissionDenied);
        call(port, "/t.S/M", Bytes::new(), &[]).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_message_past_the_decode_limit_never_reaches_the_handler() {
        let counter = Arc::new(AtomicUsize::new(0));
        let count = counter.clone();
        let (mut server, port) = start(|s| {
            s.on_grpc(Arc::new(move |_call: GrpcCall| {
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { GrpcReply::Message(Bytes::new()) })
            }))
        })
        .await;

        let five_mib = Bytes::from(vec![0u8; 5 * 1024 * 1024]);
        let error = call(port, "/t.S/M", five_mib, &[]).await.unwrap_err();
        // tonic's answer to a message over its decode limit.
        assert_eq!(error.code(), Code::OutOfRange);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }
}

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
//! headers, before a byte of the message is read — a call they refuse never
//! reaches the handler.
//!
//! The request side of a call is read here, not by tonic, which would drain
//! every further message and merge the client's trailers into the metadata:
//! exactly one message, bounded by [`GrpcLimits`] (checked on its length
//! prefix, before it is buffered), then the end of the stream, all within the
//! server's request timeout. A second message, request trailers, a message cut
//! short or none at all are refused before the handler runs.

use crate::ip::TrustedProxies;
use crate::ratelimit::RateLimiter;
use crate::request::ReamRequest;
use crate::security::{FilterResult, SecurityFilter};
use bytes::{Buf, BufMut, Bytes, BytesMut};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::server::{Grpc, UnaryService};
use tonic::{Code, Status};

/// One unary call, as the handler receives it.
pub struct GrpcCall {
    /// `/package.Service/Method`, as it arrived.
    pub path: String,
    /// Request metadata: the request headers, every value of a repeated one
    /// in order, names lowercased. Values that are not visible ASCII are left
    /// out.
    pub metadata: HashMap<String, Vec<String>>,
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

/// Message size bounds, in bytes — grpc-js's `grpc.max_receive_message_length`
/// and `grpc.max_send_message_length`, with the same defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrpcLimits {
    /// A larger request message is answered `RESOURCE_EXHAUSTED` before it is
    /// read. Default 4 MiB.
    pub max_receive_message_length: usize,
    /// A larger reply is answered `RESOURCE_EXHAUSTED` instead. Default: none.
    pub max_send_message_length: usize,
}

impl Default for GrpcLimits {
    fn default() -> Self {
        Self {
            max_receive_message_length: 4 * 1024 * 1024,
            max_send_message_length: usize::MAX,
        }
    }
}

/// The protections the HTTP path applies, applied to a gRPC call.
pub(crate) struct Guards<'a> {
    pub peer_ip: &'a str,
    pub trusted_proxies: &'a TrustedProxies,
    pub rate_limiter: Option<&'a Arc<RateLimiter>>,
    pub security_filter: Option<&'a Arc<dyn SecurityFilter>>,
    pub limits: GrpcLimits,
    /// The HTTP path's request timeout, bounding the request side of a call.
    pub request_timeout: Option<Duration>,
}

/// Guard, then serve one gRPC call.
pub(crate) async fn serve(
    req: Request<Incoming>,
    handler: GrpcHandler,
    guards: Guards<'_>,
) -> Response<tonic::body::Body> {
    let headers = crate::server::request_headers(req.uri(), req.headers());
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

    // The metadata is the request HEADERS, read now: tonic would merge the
    // client's trailers into it, and a trailer would then replace a header
    // the security filter and any proxy in front already checked.
    let metadata = metadata_of(req.headers());
    let path = req.uri().path().to_owned();

    let (parts, body) = req.into_parts();
    let read = read_message(body, guards.limits.max_receive_message_length);
    let message = match guards.request_timeout {
        Some(limit) => tokio::time::timeout(limit, read).await.unwrap_or_else(|_| {
            Err(Status::deadline_exceeded(
                "The request was not received in time",
            ))
        }),
        None => read.await,
    };
    let message = match message {
        Ok(message) => message,
        Err(status) => return status.into_http(),
    };

    // tonic still owns the response: framing, status, trailers. It gets the
    // one message read above, as a body that ends with it.
    Grpc::new(BytesCodec)
        .max_decoding_message_size(usize::MAX)
        .max_encoding_message_size(usize::MAX)
        .unary(
            Unary {
                path,
                ip,
                handler,
                metadata: Some(metadata),
                max_send: guards.limits.max_send_message_length,
            },
            Request::from_parts(parts, Full::new(message)),
        )
        .await
}

/// Read the request side of a unary call: one length-prefixed message (the
/// prefix kept), then the end of the stream.
async fn read_message(mut body: Incoming, max: usize) -> Result<Bytes, Status> {
    let mut framed = BytesMut::new();
    // The message length, once its 5-byte prefix has arrived.
    let mut length: Option<usize> = None;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| Status::cancelled("The request stream failed"))?;
        let Ok(mut data) = frame.into_data() else {
            return Err(Status::internal(
                "Request trailers are not part of a gRPC call",
            ));
        };
        while !data.is_empty() {
            let wanted = match length {
                None => 5 - framed.len(),
                Some(len) => 5 + len - framed.len(),
            };
            if wanted == 0 {
                // grpc-js answers the same, instead of draining the rest.
                return Err(Status::unimplemented("Received a second request message"));
            }
            framed.extend_from_slice(&data.split_to(wanted.min(data.len())));
            if length.is_none() && framed.len() == 5 {
                let len = u32::from_be_bytes([framed[1], framed[2], framed[3], framed[4]]) as usize;
                if len > max {
                    return Err(Status::resource_exhausted(format!(
                        "Received message larger than max ({len} vs {max})"
                    )));
                }
                length = Some(len);
            }
        }
    }
    match length {
        Some(len) if framed.len() == 5 + len => Ok(framed.freeze()),
        None if framed.is_empty() => Err(Status::internal("Missing request message.")),
        _ => Err(Status::internal("Unexpected EOF decoding stream.")),
    }
}

/// Request metadata from the headers, keeping every value of a repeated
/// one. Values that are not visible ASCII are left out.
fn metadata_of(headers: &hyper::HeaderMap) -> HashMap<String, Vec<String>> {
    let mut metadata: HashMap<String, Vec<String>> = HashMap::new();
    for (name, value) in headers {
        if let Ok(value) = value.to_str() {
            metadata
                .entry(name.as_str().to_owned())
                .or_default()
                .push(value.to_owned());
        }
    }
    metadata
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
    /// Taken by the one call this service serves.
    metadata: Option<HashMap<String, Vec<String>>>,
    max_send: usize,
}

impl UnaryService<Bytes> for Unary {
    type Response = Bytes;
    type Future = Pin<Box<dyn Future<Output = Result<tonic::Response<Bytes>, Status>> + Send>>;

    fn call(&mut self, request: tonic::Request<Bytes>) -> Self::Future {
        let call = GrpcCall {
            path: self.path.clone(),
            metadata: self.metadata.take().unwrap_or_default(),
            message: request.into_inner(),
            ip: self.ip.clone(),
        };
        let reply = (self.handler)(call);
        let max_send = self.max_send;
        Box::pin(async move {
            match reply.await {
                GrpcReply::Message(message) if message.len() > max_send => {
                    Err(Status::resource_exhausted(format!(
                        "Sent message larger than max ({} vs. {max_send})",
                        message.len()
                    )))
                }
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
                seen[0].metadata.get("authorization"),
                Some(&vec!["Bearer t0ken".to_owned()])
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
        // Past the default 4 MiB, answered like grpc-js answers it.
        assert_eq!(error.code(), Code::ResourceExhausted);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    /// A raw HTTP/2 connection, for what a gRPC client never sends.
    async fn h2_client(port: u16) -> h2::client::SendRequest<Bytes> {
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let (client, connection) = h2::client::handshake(tcp).await.unwrap();
        tokio::spawn(connection);
        client.ready().await.unwrap()
    }

    fn grpc_request(path: &str, headers: &[(&str, &str)]) -> hyper::Request<()> {
        let mut request = hyper::Request::post(format!("http://127.0.0.1{path}"))
            .header("content-type", "application/grpc")
            .header("te", "trailers");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.body(()).unwrap()
    }

    /// One length-prefixed gRPC message.
    fn frame(message: &[u8]) -> Bytes {
        let mut out = Vec::with_capacity(5 + message.len());
        out.push(0);
        out.extend_from_slice(&(message.len() as u32).to_be_bytes());
        out.extend_from_slice(message);
        Bytes::from(out)
    }

    /// The `grpc-status` (and message) of a response, from its headers when
    /// it is trailers-only, else from its trailers.
    async fn grpc_status(response: h2::client::ResponseFuture) -> (Option<String>, Option<String>) {
        let response = response.await.unwrap();
        let read = |map: &hyper::HeaderMap| {
            (
                map.get("grpc-status")
                    .map(|v| v.to_str().unwrap().to_owned()),
                map.get("grpc-message").map(|v| {
                    urlencoding::decode(v.to_str().unwrap())
                        .unwrap()
                        .into_owned()
                }),
            )
        };
        let from_headers = read(response.headers());
        if from_headers.0.is_some() {
            return from_headers;
        }
        let mut body = response.into_body();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.unwrap();
            let _ = body.flow_control().release_capacity(chunk.len());
        }
        match body.trailers().await.unwrap() {
            Some(trailers) => read(&trailers),
            None => (None, None),
        }
    }

    /// A handler that counts its calls and answers `reply`.
    fn counting_handler(counter: Arc<AtomicUsize>, reply: &'static [u8]) -> GrpcHandler {
        Arc::new(move |_call: GrpcCall| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { GrpcReply::Message(Bytes::from_static(reply)) })
        })
    }

    async fn start_bounded(
        counter: Arc<AtomicUsize>,
        reply: &'static [u8],
        limits: GrpcLimits,
    ) -> (ReamServer, u16) {
        start(|s| {
            s.on_grpc(counting_handler(counter, reply));
            s.set_grpc_limits(limits);
            s.set_connection_limits(crate::ConnectionLimits {
                request_timeout: Some(Duration::from_millis(300)),
                ..crate::ConnectionLimits::default()
            });
        })
        .await
    }

    #[tokio::test]
    async fn a_call_whose_request_never_ends_is_answered_at_the_request_timeout() {
        let counter = Arc::new(AtomicUsize::new(0));
        let (mut server, port) = start_bounded(counter.clone(), b"", GrpcLimits::default()).await;

        let mut client = h2_client(port).await;
        let (response, mut stream) = client
            .send_request(grpc_request("/t.S/M", &[]), false)
            .unwrap();
        stream.send_data(frame(b"x"), false).unwrap();
        let started = std::time::Instant::now();
        let (status, _) = tokio::time::timeout(Duration::from_secs(3), grpc_status(response))
            .await
            .expect("answered before the client gave up");
        assert_eq!(status.as_deref(), Some("4"));
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        drop(stream);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_second_message_on_a_unary_call_is_refused_at_once() {
        let counter = Arc::new(AtomicUsize::new(0));
        let (mut server, port) = start_bounded(counter.clone(), b"", GrpcLimits::default()).await;

        let mut client = h2_client(port).await;
        let (response, mut stream) = client
            .send_request(grpc_request("/t.S/M", &[]), false)
            .unwrap();
        stream.send_data(frame(b"one"), false).unwrap();
        stream.send_data(frame(b"two"), false).unwrap();
        let started = std::time::Instant::now();
        let (status, message) = grpc_status(response).await;
        assert_eq!(status.as_deref(), Some("12"));
        assert_eq!(
            message.as_deref(),
            Some("Received a second request message")
        );
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn request_trailers_are_refused_before_the_handler() {
        let counter = Arc::new(AtomicUsize::new(0));
        let (mut server, port) = start_bounded(counter.clone(), b"", GrpcLimits::default()).await;

        let mut client = h2_client(port).await;
        let (response, mut stream) = client
            .send_request(grpc_request("/t.S/M", &[]), false)
            .unwrap();
        stream.send_data(frame(b"x"), false).unwrap();
        let mut trailers = hyper::HeaderMap::new();
        trailers.insert("authorization", "Bearer forged".parse().unwrap());
        stream.send_trailers(trailers).unwrap();
        let (status, _) = grpc_status(response).await;
        assert_eq!(status.as_deref(), Some("13"));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_length_prefix_past_the_limit_is_refused_before_the_message_is_read() {
        let counter = Arc::new(AtomicUsize::new(0));
        let limits = GrpcLimits {
            max_receive_message_length: 8,
            ..GrpcLimits::default()
        };
        let (mut server, port) = start_bounded(counter.clone(), b"", limits).await;

        // Only the prefix, announcing 1 GiB, and the stream left open: the
        // answer must not wait for (or make room for) the message.
        let mut client = h2_client(port).await;
        let (response, mut stream) = client
            .send_request(grpc_request("/t.S/M", &[]), false)
            .unwrap();
        let mut prefix = vec![0u8];
        prefix.extend_from_slice(&(1u32 << 30).to_be_bytes());
        stream.send_data(Bytes::from(prefix), false).unwrap();
        let (status, message) = grpc_status(response).await;
        assert_eq!(status.as_deref(), Some("8"));
        assert_eq!(
            message.as_deref(),
            Some("Received message larger than max (1073741824 vs 8)")
        );
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn the_receive_limit_is_inclusive_and_configurable() {
        let counter = Arc::new(AtomicUsize::new(0));
        let limits = GrpcLimits {
            max_receive_message_length: 8,
            ..GrpcLimits::default()
        };
        let (mut server, port) = start_bounded(counter.clone(), b"ok", limits).await;

        call(port, "/t.S/M", Bytes::from_static(b"12345678"), &[])
            .await
            .unwrap();
        let error = call(port, "/t.S/M", Bytes::from_static(b"123456789"), &[])
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::ResourceExhausted);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_reply_past_the_send_limit_is_answered_resource_exhausted() {
        let counter = Arc::new(AtomicUsize::new(0));
        let limits = GrpcLimits {
            max_send_message_length: 2,
            ..GrpcLimits::default()
        };
        let (mut server, port) = start_bounded(counter.clone(), b"abc", limits).await;

        let error = call(port, "/t.S/M", Bytes::new(), &[]).await.unwrap_err();
        assert_eq!(error.code(), Code::ResourceExhausted);
        assert_eq!(error.message(), "Sent message larger than max (3 vs. 2)");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_call_without_a_message_is_refused() {
        let counter = Arc::new(AtomicUsize::new(0));
        let (mut server, port) = start_bounded(counter.clone(), b"", GrpcLimits::default()).await;

        let mut client = h2_client(port).await;
        let (response, _stream) = client
            .send_request(grpc_request("/t.S/M", &[]), true)
            .unwrap();
        let (status, _) = grpc_status(response).await;
        assert_eq!(status.as_deref(), Some("13"));

        // A message cut short: the prefix announces more than arrives.
        let mut client = h2_client(port).await;
        let (response, mut stream) = client
            .send_request(grpc_request("/t.S/M", &[]), false)
            .unwrap();
        stream
            .send_data(Bytes::from_static(&[0, 0, 0, 0, 9, 1, 2]), true)
            .unwrap();
        let (status, _) = grpc_status(response).await;
        assert_eq!(status.as_deref(), Some("13"));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn every_value_of_a_repeated_header_reaches_the_handler() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler = recording_handler(seen.clone());
        let (mut server, port) = start(|s| s.on_grpc(handler)).await;

        let mut client = h2_client(port).await;
        let (response, mut stream) = client
            .send_request(
                grpc_request("/t.S/M", &[("x-dup", "a"), ("x-dup", "b"), ("x-one", "1")]),
                false,
            )
            .unwrap();
        stream.send_data(frame(b"x"), true).unwrap();
        assert_eq!(grpc_status(response).await.0.as_deref(), Some("0"));
        {
            let seen = seen.lock().unwrap();
            assert_eq!(
                seen[0].metadata.get("x-dup"),
                Some(&vec!["a".to_owned(), "b".to_owned()])
            );
            assert_eq!(seen[0].metadata.get("x-one"), Some(&vec!["1".to_owned()]));
        }
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_client_reset_drops_the_handler_future() {
        use std::sync::atomic::AtomicBool;
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let started = Arc::new(tokio::sync::Notify::new());
        let (flag, notify) = (dropped.clone(), started.clone());
        let (mut server, port) = start(|s| {
            s.on_grpc(Arc::new(move |_call: GrpcCall| {
                let guard = Dropped(flag.clone());
                notify.notify_one();
                Box::pin(async move {
                    let _guard = guard;
                    std::future::pending::<GrpcReply>().await
                })
            }))
        })
        .await;

        let mut client = h2_client(port).await;
        let (_response, mut stream) = client
            .send_request(grpc_request("/t.S/M", &[]), false)
            .unwrap();
        stream.send_data(frame(b"x"), true).unwrap();
        started.notified().await;
        assert!(!dropped.load(Ordering::SeqCst));
        stream.send_reset(h2::Reason::CANCEL);
        // The future is what carries the cancellation to the handler's host.
        tokio::time::timeout(Duration::from_secs(2), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the handler future was dropped on the client's reset");
        server.shutdown().await;
    }
}

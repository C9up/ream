//! Hyper HTTP server implementation.
//!
//! @implements FR23

use crate::ip::TrustedProxies;
use crate::limits::{BodyLimits, ConnectionLimits};
use crate::request::ReamRequest;
use crate::response::ReamResponse;
use crate::stream_registry::StreamRegistry;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use http_body_util::{combinators::BoxBody, BodyExt, Either, Full, StreamBody};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder as AutoBuilder;
use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch, Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
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

/// Pause after a failed `accept()` before trying again. The usual failure is
/// running out of file descriptors (`EMFILE`); retrying at once would spin a
/// core until a descriptor frees up.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);

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
    /// Proxies whose `X-Forwarded-For` hops are believed. Empty = strict
    /// fail-closed (only the socket peer is used).
    trusted_proxies: Arc<TrustedProxies>,
    rate_limiter: Option<Arc<crate::RateLimiter>>,
    /// Stream registry — populated by JS via NAPI when the handler upgrades
    /// the response to streaming mode (SSE etc.). Always cloned out into the
    /// per-connection task so handlers / NAPI keep a coherent view.
    stream_registry: StreamRegistry,
    /// gRPC handler. `None` (default) leaves `application/grpc` requests on
    /// the HTTP path, exactly as before gRPC existed.
    grpc_handler: Option<crate::GrpcHandler>,
    /// Message size bounds of the gRPC calls.
    grpc_limits: crate::GrpcLimits,
    /// Request-body limits per content type, enforced while the body is read.
    body_limits: Arc<BodyLimits>,
    /// Header / body / keep-alive timeouts and the connection cap.
    connection_limits: ConnectionLimits,
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
            trusted_proxies: Arc::new(TrustedProxies::default()),
            rate_limiter: None,
            stream_registry: StreamRegistry::new(),
            grpc_handler: None,
            grpc_limits: crate::GrpcLimits::default(),
            body_limits: Arc::new(BodyLimits::default()),
            connection_limits: ConnectionLimits::default(),
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

    /// Configure the trusted proxies used by `request.ip` resolution. Empty
    /// (the default) ignores `X-Forwarded-For` entirely. See
    /// [`TrustedProxies`] for the accepted entries.
    pub fn set_trusted_proxies(&mut self, proxies: TrustedProxies) {
        self.trusted_proxies = Arc::new(proxies);
    }

    /// Configure the request-body limits. Defaults to the body parser's.
    pub fn set_body_limits(&mut self, limits: BodyLimits) {
        self.body_limits = Arc::new(limits);
    }

    /// Configure timeouts and the connection cap. Must be set before
    /// `listen()`.
    pub fn set_connection_limits(&mut self, limits: ConnectionLimits) {
        self.connection_limits = limits;
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

    /// Register the gRPC handler: from then on, `application/grpc` requests
    /// are served as gRPC calls on this same port (see [`crate::grpc`]).
    pub fn on_grpc(&mut self, handler: crate::GrpcHandler) {
        self.grpc_handler = Some(handler);
    }

    /// Bound the messages of the gRPC calls served (default: 4 MiB received,
    /// no bound sent).
    pub fn set_grpc_limits(&mut self, limits: crate::GrpcLimits) {
        self.grpc_limits = limits;
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
        let limits = self.connection_limits;
        let context = Arc::new(ServeContext {
            handler,
            security_filter: self.security_filter.clone(),
            response_filter: self.response_filter.clone(),
            trusted_proxies: self.trusted_proxies.clone(),
            rate_limiter: self.rate_limiter.clone(),
            stream_registry: self.stream_registry.clone(),
            grpc_handler: self.grpc_handler.clone(),
            grpc_limits: self.grpc_limits,
            body_limits: self.body_limits.clone(),
            limits,
        });

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

        // Auto-detect HTTP/1.1 vs HTTP/2. hyper only enforces its header-read
        // timeout when a timer is installed; without one a client that never
        // finishes its headers holds the connection forever.
        let mut builder = AutoBuilder::new(TokioExecutor::new());
        builder
            .http1()
            .timer(TokioTimer::new())
            .header_read_timeout(limits.headers_timeout);
        builder.http2().timer(TokioTimer::new());

        let connection_slots =
            (limits.max_connections > 0).then(|| Arc::new(Semaphore::new(limits.max_connections)));

        self.accept_handle = Some(tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;

            loop {
                // Wait for a free slot BEFORE accepting: past the cap, new
                // clients queue in the kernel's listen backlog instead of
                // each costing a task and a descriptor here.
                let slot = match &connection_slots {
                    Some(slots) => tokio::select! {
                        permit = slots.clone().acquire_owned() => match permit {
                            Ok(permit) => Some(permit),
                            Err(_) => break,
                        },
                        _ = &mut shutdown_rx => break,
                    },
                    None => None,
                };

                tokio::select! {
                    result = listener.accept() => {
                        match result {
                            Ok((stream, peer_addr)) => {
                                tokio::spawn(serve_connection(
                                    stream,
                                    Arc::from(peer_addr.ip().to_string()),
                                    context.clone(),
                                    builder.clone(),
                                    conn_shutdown_rx.clone(),
                                    slot,
                                ));
                            }
                            Err(_e) => {
                                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                            }
                        }
                    }
                    _ = &mut shutdown_rx => break,
                }
            }

            let mut port = actual_port.lock().await;
            *port = 0;
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

/// Everything a connection task needs, shared by every connection.
struct ServeContext {
    handler: RequestHandler,
    security_filter: Option<Arc<dyn crate::SecurityFilter>>,
    response_filter: Option<ResponseFilter>,
    trusted_proxies: Arc<TrustedProxies>,
    rate_limiter: Option<Arc<crate::RateLimiter>>,
    stream_registry: StreamRegistry,
    grpc_handler: Option<crate::GrpcHandler>,
    grpc_limits: crate::GrpcLimits,
    body_limits: Arc<BodyLimits>,
    limits: ConnectionLimits,
}

type ServiceBody = Either<ResponseBody, tonic::body::Body>;

/// Serve one accepted connection until it closes, the server shuts down, or
/// it sits idle past its bound. `_slot` is the connection-cap permit, released
/// when this task ends.
async fn serve_connection(
    stream: TcpStream,
    peer_ip: Arc<str>,
    context: Arc<ServeContext>,
    builder: AutoBuilder<TokioExecutor>,
    mut conn_shutdown: watch::Receiver<bool>,
    _slot: Option<OwnedSemaphorePermit>,
) {
    let activity = Arc::new(ConnActivity::new());
    let service = {
        let activity = activity.clone();
        let context = context.clone();
        service_fn(move |req: Request<Incoming>| {
            let in_flight = activity.begin();
            let context = context.clone();
            let peer_ip = peer_ip.clone();
            async move {
                let response = handle_request(req, &peer_ip, &context).await?;
                // The guard rides on the body: the request counts as in
                // flight until its response — SSE included — is fully sent.
                Ok::<_, hyper::Error>(response.map(|body| TrackedBody {
                    inner: body,
                    _in_flight: in_flight,
                }))
            }
        })
    };

    let conn = builder.serve_connection(TokioIo::new(stream), service);
    tokio::pin!(conn);
    tokio::select! {
        res = conn.as_mut() => {
            if let Err(_e) = res {
                // Connection error — client disconnected, header timeout, etc.
            }
        }
        _ = conn_shutdown.changed() => {
            // Server is shutting down: ask the connection to wind down (finish
            // any in-flight request, stop reading new ones), then await its
            // end. SSE bodies were EOF'd by the registry drain, so they finish
            // here too — the task ends and drops its handler clone, releasing
            // the tsfn that pins Node's loop.
            conn.as_mut().graceful_shutdown();
            let _ = conn.as_mut().await;
        }
        _ = activity.idle_expired(context.limits.headers_timeout, context.limits.keep_alive_timeout) => {
            // Nothing in flight and nothing asked for in time: close. Graceful,
            // so an HTTP/2 client gets its GOAWAY.
            conn.as_mut().graceful_shutdown();
            let _ = conn.as_mut().await;
        }
    }
}

/// What a connection is doing, for its idle bound.
struct ConnActivity {
    state: std::sync::Mutex<ActivityState>,
    changed: Notify,
}

struct ActivityState {
    in_flight: usize,
    /// Whether a response has been completed on this connection: before it,
    /// the idle bound is the header timeout; after it, the keep-alive one.
    served: bool,
    idle_since: Instant,
}

impl ConnActivity {
    fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(ActivityState {
                in_flight: 0,
                served: false,
                idle_since: Instant::now(),
            }),
            changed: Notify::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ActivityState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(self: &Arc<Self>) -> InFlight {
        self.lock().in_flight += 1;
        InFlight(self.clone())
    }

    /// Resolves once the connection has had nothing in flight for longer
    /// than its bound: `first_request` until a response has been completed
    /// (a client that connects and sends nothing — not even the bytes
    /// HTTP-version detection waits for — is closed like one that never
    /// finishes its headers), `keep_alive` afterwards. A `None` bound never
    /// expires.
    async fn idle_expired(&self, first_request: Option<Duration>, keep_alive: Option<Duration>) {
        loop {
            let deadline = {
                let state = self.lock();
                if state.in_flight > 0 {
                    None
                } else {
                    let bound = if state.served {
                        keep_alive
                    } else {
                        first_request
                    };
                    bound.map(|bound| state.idle_since + bound)
                }
            };
            match deadline {
                Some(at) if at <= Instant::now() => return,
                Some(at) => {
                    tokio::select! {
                        _ = tokio::time::sleep_until(at) => {}
                        _ = self.changed.notified() => {}
                    }
                }
                None => self.changed.notified().await,
            }
        }
    }
}

/// One request in flight on a connection. Dropped when its response body is
/// finished (or abandoned).
struct InFlight(Arc<ConnActivity>);

impl Drop for InFlight {
    fn drop(&mut self) {
        {
            let mut state = self.0.lock();
            state.in_flight = state.in_flight.saturating_sub(1);
            state.served = true;
            if state.in_flight == 0 {
                state.idle_since = Instant::now();
            }
        }
        // `notify_one` keeps a permit when the watcher is not waiting yet, so
        // the transition is never missed.
        self.0.changed.notify_one();
    }
}

/// A response body carrying the in-flight guard of its request.
struct TrackedBody<B> {
    inner: B,
    _in_flight: InFlight,
}

impl<B: Body + Unpin> Body for TrackedBody<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Route one request through the guards, then to the gRPC or HTTP handler.
async fn handle_request(
    req: Request<Incoming>,
    peer_ip: &str,
    context: &ServeContext,
) -> Result<Response<ServiceBody>, hyper::Error> {
    let registry = &context.stream_registry;
    if let Some(grpc) = context
        .grpc_handler
        .clone()
        .filter(|_| crate::grpc::is_grpc(&req))
    {
        let guards = crate::grpc::Guards {
            peer_ip,
            trusted_proxies: &context.trusted_proxies,
            rate_limiter: context.rate_limiter.as_ref(),
            security_filter: context.security_filter.as_ref(),
            limits: context.grpc_limits,
            request_timeout: context.limits.request_timeout,
        };
        return Ok(crate::grpc::serve(req, grpc, guards)
            .await
            .map(Either::Right));
    }
    let ream_req = match hyper_to_ream_request(req, peer_ip, context).await {
        Ok(r) => r,
        Err(res) => {
            // Body over its limit, too slow, or malformed — answered from
            // Rust, no NAPI crossing.
            return build_hyper_response(res, registry)
                .await
                .map(|r| r.map(Either::Left));
        }
    };

    // Security filter check BEFORE NAPI crossing
    let ream_req = if let Some(ref filter) = context.security_filter {
        match filter.check(ream_req) {
            crate::FilterResult::Allow(req) => req,
            crate::FilterResult::Sanitized(req) => req,
            crate::FilterResult::Reject(res) => {
                // Rejected — return directly from Rust, no NAPI crossing
                return build_hyper_response(res, registry)
                    .await
                    .map(|r| r.map(Either::Left));
            }
        }
    } else {
        ream_req
    };

    // Rate limit BEFORE NAPI crossing — blocked requests never pay the JS
    // dispatch cost. The outcome is also stitched into the eventual response
    // headers.
    let rate_outcome = context.rate_limiter.as_ref().map(|l| l.check(&ream_req.ip));
    if let Some(outcome) = rate_outcome {
        if !outcome.allowed {
            return build_hyper_response(rate_limited_response(outcome), registry)
                .await
                .map(|r| r.map(Either::Left));
        }
    }

    let mut ream_res = (context.handler)(ream_req).await;

    // Apply response filter (XSS sanitization for HTML/text) — skipped for
    // streamed bodies. A sanitizer that scans an SSE wire (`event:
    // foo\ndata: bar\n\n`) would butcher the framing.
    if !ream_res.is_streaming() {
        if let Some(ref rf) = context.response_filter {
            ream_res = (rf)(ream_res);
        }
    }

    // Stitch rate-limit headers onto allowed responses so well-behaved
    // clients can self-throttle.
    if let Some(outcome) = rate_outcome {
        attach_rate_limit_headers(&mut ream_res, outcome);
    }

    build_hyper_response(ream_res, registry)
        .await
        .map(|r| r.map(Either::Left))
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

/// The request target as `/path?query`, whatever form the URI arrived in.
pub(crate) fn origin_form(uri: &hyper::Uri) -> String {
    uri.path_and_query()
        .map_or_else(|| uri.path().to_string(), |pq| pq.as_str().to_string())
}

/// Headers Node keeps the FIRST value of when a request repeats them, and
/// drops every later line (`_http_incoming.js`, `matchKnownFields`). A
/// duplicate `Host` must not move routing to the second line.
const FIRST_VALUE_WINS: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

/// A header value as Node's `http` module exposes it. Visible ASCII comes
/// through as is; a value carrying an obs-text byte (0x80 and above, which
/// HTTP/1.1 allows) is read as latin1, one character per byte, rather than
/// dropped from the map.
fn header_value_string(value: &hyper::header::HeaderValue) -> String {
    match value.to_str() {
        Ok(text) => text.to_owned(),
        Err(_) => value
            .as_bytes()
            .iter()
            .map(|&byte| char::from(byte))
            .collect(),
    }
}

/// Flatten the request headers into a name → value map (names lowercase),
/// joining repeated lines the way Node does: `Cookie` with `"; "` (HTTP/2
/// clients send one line per cookie), the headers of [`FIRST_VALUE_WINS`]
/// keep their first line, and every other one is joined with `", "`.
pub(crate) fn collect_headers(map: &hyper::HeaderMap) -> HashMap<String, String> {
    let mut headers: HashMap<String, String> = HashMap::with_capacity(map.keys_len());
    for (name, value) in map {
        let value = header_value_string(value);
        let name = name.as_str();
        let Some(existing) = headers.get_mut(name) else {
            headers.insert(name.to_owned(), value);
            continue;
        };
        if FIRST_VALUE_WINS.contains(&name) {
            continue;
        }
        existing.push_str(if name == "cookie" { "; " } else { ", " });
        existing.push_str(&value);
    }
    headers
}

/// The request headers as JavaScript reads them: [`collect_headers`], plus a
/// `host` taken from the URI's authority when no `Host` line was sent. Over
/// HTTP/2 the authority travels as the `:authority` pseudo-header, which
/// hyper keeps in the URI and never in the header map, so without this every
/// HTTP/2 request reached the application with no host at all.
pub(crate) fn request_headers(uri: &hyper::Uri, map: &hyper::HeaderMap) -> HashMap<String, String> {
    let mut headers = collect_headers(map);
    if !headers.contains_key("host") {
        if let Some(authority) = uri.authority() {
            // `host[:port]` only: an authority's userinfo is never a host.
            let host = match authority.port() {
                Some(port) => format!("{}:{}", authority.host(), port),
                None => authority.host().to_owned(),
            };
            headers.insert("host".to_owned(), host);
        }
    }
    headers
}

/// The most of an over-limit body the server reads and throws away while the
/// request is answered without it, so a client still uploading receives the
/// answer instead of a reset connection (Node discards an unread body the
/// same way). Past it, or past the request timeout, the connection is
/// dropped.
const DISCARD_LIMIT: u64 = 128 * 1024 * 1024;

/// A rejection answered before the request body was fully read. The
/// connection is not reused after it.
fn early_rejection(status: u16, body: &'static str) -> ReamResponse {
    let mut response = ReamResponse::json(status, body);
    response.headers.insert("connection".into(), "close".into());
    response
}

fn request_timeout() -> ReamResponse {
    early_rejection(
        408,
        r#"{"error":{"code":"E_HTTP_REQUEST_TIMEOUT","message":"Request body not received in time"}}"#,
    )
}

fn request_aborted() -> ReamResponse {
    early_rejection(
        400,
        r#"{"error":{"code":"E_REQUEST_ABORTED","message":"request aborted"}}"#,
    )
}

/// How the rest of a refused body is dealt with.
#[derive(Clone, Copy)]
struct Discard {
    /// The client asked `Expect: 100-continue`: reading would invite the body
    /// it has not sent yet, so nothing is read.
    expects_continue: bool,
    timeout: Option<Duration>,
}

impl Discard {
    /// Read and drop what is left of `body` in the background, within
    /// [`DISCARD_LIMIT`] and the request timeout. `already` bytes were read.
    fn rest(self, body: Incoming, already: u64) {
        let remaining = DISCARD_LIMIT.saturating_sub(already);
        if self.expects_continue || body.size_hint().lower() > remaining {
            return;
        }
        let drain = async move {
            let mut body = body;
            let mut seen = 0u64;
            while let Some(Ok(frame)) = body.frame().await {
                if let Some(data) = frame.data_ref() {
                    seen += data.len() as u64;
                    if seen > remaining {
                        return;
                    }
                }
            }
        };
        let timeout = self.timeout;
        tokio::spawn(async move {
            match timeout {
                Some(timeout) => {
                    let _ = tokio::time::timeout(timeout, drain).await;
                }
                None => drain.await,
            }
        });
    }
}

/// Read the request body within its size limit and the request timeout.
///
/// `Ok(None)` means the body is over its limit: a declared `Content-Length`
/// over it is not read at all, a chunked body stops being kept the moment it
/// passes it. Either way nothing more is buffered — the rest is discarded
/// (see [`Discard`]) — and the request still goes to the application, without
/// a body, so routing answers first and the body parser raises the 413.
async fn read_body(
    body: Incoming,
    limit: u64,
    timeout: Option<Duration>,
    discard: Discard,
) -> Result<Option<Bytes>, ReamResponse> {
    if body.size_hint().lower() > limit {
        discard.rest(body, 0);
        return Ok(None);
    }
    let read = async move {
        let mut body = body;
        let mut collected = BytesMut::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| request_aborted())?;
            if let Ok(data) = frame.into_data() {
                let total = collected.len() as u64 + data.len() as u64;
                if total > limit {
                    discard.rest(body, total);
                    return Ok(None);
                }
                collected.extend_from_slice(&data);
            }
        }
        Ok(Some(collected.freeze()))
    };
    match timeout {
        Some(timeout) => tokio::time::timeout(timeout, read)
            .await
            .map_err(|_| request_timeout())?,
        None => read.await,
    }
}

/// Convert a hyper Request to a ReamRequest, including the TCP peer IP and
/// the resolved client IP (per the configured trusted proxies).
async fn hyper_to_ream_request(
    req: Request<Incoming>,
    peer_ip: &str,
    context: &ServeContext,
) -> Result<ReamRequest, ReamResponse> {
    let method = req.method().to_string();
    // Origin form (`/path?query`). Over HTTP/2 the URI is absolute — it
    // carries `:scheme` and `:authority` — and `to_string()` handed the router
    // `http://host:port/path` to match its routes against.
    let uri = origin_form(req.uri());
    let headers = request_headers(req.uri(), req.headers());
    let content_type = headers.get("content-type").cloned().unwrap_or_default();

    // The body-parser limit for this content type, applied while reading:
    // nothing past it is ever buffered.
    let discard = Discard {
        expects_continue: headers
            .get("expect")
            .is_some_and(|v| v.eq_ignore_ascii_case("100-continue")),
        timeout: context.limits.request_timeout,
    };
    let body_bytes = read_body(
        req.into_body(),
        context.body_limits.limit_for(&content_type),
        context.limits.request_timeout,
        discard,
    )
    .await?;

    let ips = crate::ip::resolve_client_ips(peer_ip, &headers, &context.trusted_proxies);
    let resolved_ip = ips.last().cloned().unwrap_or_else(|| "127.0.0.1".into());
    let peer_trusted = context.trusted_proxies.trusts(peer_ip);
    let cookie_header = headers.get("cookie").cloned().unwrap_or_default();
    let cookies = crate::cookies::parse_cookie_header(&cookie_header);
    let peer_ip = peer_ip.to_string();

    // Over the limit: no body at all, and the marker that says so. The body
    // parser turns it into a 413 once the route is known.
    let Some(body_bytes) = body_bytes else {
        let mut req =
            ReamRequest::from_hyper_with_addr(&method, &uri, headers, String::new(), peer_ip);
        req.body_too_large = true;
        req.ip = resolved_ip;
        req.ips = ips;
        req.peer_trusted = peer_trusted;
        req.cookies = cookies;
        return Ok(req);
    };

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
        req.ips = ips;
        req.peer_trusted = peer_trusted;
        req.multipart = payload;
        req.cookies = cookies;
        return Ok(req);
    }

    // Other binary content (`application/octet-stream`, etc.) still rides as
    // base64 — JS layer decodes via `Request.rawBuffer()`.
    let is_binary = content_type.starts_with("application/octet-stream");
    let mut req = if is_binary {
        use base64::Engine;
        let body = base64::engine::general_purpose::STANDARD.encode(&body_bytes);
        let mut req = ReamRequest::from_hyper_with_addr(&method, &uri, headers, body, peer_ip);
        req.body_encoding = "base64".to_string();
        req
    } else {
        let body = String::from_utf8_lossy(&body_bytes).into_owned();
        ReamRequest::from_hyper_with_addr(&method, &uri, headers, body, peer_ip)
    };
    req.ip = resolved_ip;
    req.ips = ips;
    req.peer_trusted = peer_trusted;
    req.cookies = cookies;
    Ok(req)
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

    // ─── End-to-end: proxies, cookies, shield, body limits, timeouts ───

    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Start a server whose handler echoes what a test asks for and counts
    /// its calls. `configure` adjusts the server before it listens.
    async fn start(
        echo: fn(&ReamRequest) -> String,
        configure: impl FnOnce(&mut ReamServer),
    ) -> (ReamServer, u16, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(move |req| {
            counter.fetch_add(1, Ordering::SeqCst);
            let body = echo(&req);
            Box::pin(async move { ReamResponse::text(200, body) })
        }));
        configure(&mut server);
        server.listen().await.unwrap();
        let port = server.actual_port().await;
        (server, port, calls)
    }

    /// Send raw bytes, then read until the server closes (or `wait` passes).
    async fn exchange(port: u16, raw: &[u8], wait: Duration) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(raw).await.unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(wait, stream.read_to_end(&mut response)).await;
        String::from_utf8_lossy(&response).into_owned()
    }

    /// Whether the server closes `stream` within `within`.
    async fn closed_within(stream: &mut TcpStream, within: Duration) -> bool {
        let mut buf = [0u8; 1024];
        let deadline = Instant::now() + within;
        loop {
            match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => return true,
                Ok(Ok(_)) => continue,
                Err(_) => return false,
            }
        }
    }

    fn body_of(response: &str) -> &str {
        response.split("\r\n\r\n").nth(1).unwrap_or("")
    }

    #[tokio::test]
    async fn client_ip_ignores_the_spoofed_left_most_forwarded_entry() {
        let (mut server, port, _) = start(
            |req| format!("{}|{}", req.ip, req.ips.join(",")),
            |s| s.set_trusted_proxies(TrustedProxies::compile(&["127.0.0.1"]).unwrap()),
        )
        .await;
        let response = exchange(
            port,
            b"GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 6.6.6.6, 203.0.113.9\r\nConnection: close\r\n\r\n",
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(body_of(&response), "203.0.113.9|127.0.0.1,203.0.113.9");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn repeated_forwarded_for_lines_are_read_as_one_list() {
        let (mut server, port, _) = start(
            |req| req.ip.clone(),
            |s| s.set_trusted_proxies(TrustedProxies::compile(&["127.0.0.1"]).unwrap()),
        )
        .await;
        // The client's own line first, the proxy's appended line last: the
        // proxy's entry is the client IP, whatever the client wrote.
        let response = exchange(
            port,
            b"GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 203.0.113.9\r\nX-Forwarded-For: 127.0.0.1\r\nConnection: close\r\n\r\n",
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(body_of(&response), "203.0.113.9");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_duplicated_cookie_name_keeps_the_first_value() {
        let (mut server, port, _) = start(
            |req| req.cookies.get("session").cloned().unwrap_or_default(),
            |_| {},
        )
        .await;
        let response = exchange(
            port,
            b"GET / HTTP/1.1\r\nHost: x\r\nCookie: session=legit-host-only; session=tossed-by-sibling-subdomain\r\nConnection: close\r\n\r\n",
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(body_of(&response), "legit-host-only");

        // Two Cookie lines (one per cookie, as HTTP/2 clients send them)
        // keep their order instead of the last line replacing the first.
        let response = exchange(
            port,
            b"GET / HTTP/1.1\r\nHost: x\r\nCookie: session=first\r\nCookie: session=second; other=1\r\nConnection: close\r\n\r\n",
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(body_of(&response), "first");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn shield_refuses_half_encoded_traversal_on_the_wire() {
        let (mut server, port, calls) = start(
            |req| req.path.clone(),
            |s| s.set_security_filter(Arc::new(crate::ShieldFilter::new(Default::default()))),
        )
        .await;
        for path in ["/static/.%2e/etc/passwd", "/static/%2e./etc/passwd"] {
            let response = exchange(
                port,
                format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
                Duration::from_secs(5),
            )
            .await;
            assert!(response.starts_with("HTTP/1.1 400"), "{path}: {response}");
            assert!(response.contains("E_PATH_TRAVERSAL"), "{path}");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    /// Read one response from `stream`: its head, then `content-length`
    /// bytes of body — or whatever arrived before the server closed or five
    /// seconds passed.
    async fn read_response(stream: &mut TcpStream) -> String {
        let mut response = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8_lossy(&response).into_owned();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if body.len() >= length {
                    return text;
                }
            }
            match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
                Ok(Ok(n)) if n > 0 => response.extend_from_slice(&buf[..n]),
                _ => return text,
            }
        }
    }

    /// What the over-limit tests echo: the marker, then how much body JS got.
    fn over_limit_echo(req: &ReamRequest) -> String {
        format!("{}|{}", req.body_too_large, req.body.len())
    }

    #[tokio::test]
    async fn a_declared_length_over_the_limit_reaches_the_app_without_its_body() {
        let (mut server, port, calls) = start(over_limit_echo, |_| {}).await;
        // Headers only: the 40 MB body never leaves the client, and the
        // application still answers — routing decides before any 413.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"POST /does-not-exist HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 41943040\r\n\r\n")
            .await
            .unwrap();
        let response = read_response(&mut stream).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(body_of(&response), "true|0");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_client_still_uploading_receives_the_answer() {
        let (mut server, port, _) = start(over_limit_echo, |_| {}).await;
        let body = vec![b'a'; 3 * 1024 * 1024];
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                format!(
                    "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        // The whole body goes out (the server discards it rather than
        // resetting the connection under the client)...
        tokio::time::timeout(Duration::from_secs(5), stream.write_all(&body))
            .await
            .expect("the server kept reading")
            .expect("the connection was not reset");
        // ...and the answer is there, without a byte of that body.
        let response = read_response(&mut stream).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(body_of(&response), "true|0");
        assert!(closed_within(&mut stream, Duration::from_secs(5)).await);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn an_expect_continue_client_is_answered_without_being_invited_to_send() {
        let (mut server, port, _) = start(over_limit_echo, |_| {}).await;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 41943040\r\nExpect: 100-continue\r\n\r\n")
            .await
            .unwrap();
        let response = read_response(&mut stream).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(!response.contains("100 Continue"));
        assert_eq!(body_of(&response), "true|0");
        assert!(closed_within(&mut stream, Duration::from_secs(5)).await);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_chunked_body_is_dropped_once_it_passes_the_limit() {
        let (mut server, port, _) = start(over_limit_echo, |s| {
            let mut limits = BodyLimits::default();
            limits.json.limit = 16;
            s.set_body_limits(limits);
        })
        .await;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        // 8 bytes (under the limit), then past it, then the stream stays
        // open: the app is called without waiting for the rest, and none of
        // the bytes already read reach it.
        stream.write_all(b"8\r\n{\"a\":\"xx\r\n").await.unwrap();
        stream
            .write_all(b"20\r\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}\r\n")
            .await
            .unwrap();
        let response = read_response(&mut stream).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(body_of(&response), "true|0");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn each_content_type_gets_its_own_limit() {
        let (mut server, port, _) = start(
            |req| format!("{}|{}", req.body_encoding, req.body_too_large),
            |s| {
                let mut limits = BodyLimits::default();
                limits.json.limit = 64;
                limits.multipart.limit = 4096;
                s.set_body_limits(limits);
            },
        )
        .await;
        let part = format!(
            "--b\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n{}\r\n--b--\r\n",
            "n".repeat(500)
        );
        let multipart = format!(
            "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=b\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{part}",
            part.len()
        );
        let response = exchange(port, multipart.as_bytes(), Duration::from_secs(5)).await;
        assert_eq!(body_of(&response), "multipart|false");

        let json = format!("{{\"note\":\"{}\"}}", "n".repeat(500));
        let request = format!(
            "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
            json.len()
        );
        let response = exchange(port, request.as_bytes(), Duration::from_secs(5)).await;
        assert_eq!(body_of(&response), "utf8|true");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn peer_trust_is_reported_without_forwarded_for() {
        for (trusted, expected) in [(vec!["127.0.0.1"], "true"), (vec!["10.0.0.0/8"], "false")] {
            let (mut server, port, _) = start(
                |req| req.peer_trusted.to_string(),
                |s| s.set_trusted_proxies(TrustedProxies::compile(&trusted).unwrap()),
            )
            .await;
            let response = exchange(
                port,
                b"GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n",
                Duration::from_secs(5),
            )
            .await;
            assert_eq!(body_of(&response), expected, "{trusted:?}");
            server.shutdown().await;
        }
    }

    fn quick_limits() -> ConnectionLimits {
        ConnectionLimits {
            headers_timeout: Some(Duration::from_millis(300)),
            request_timeout: Some(Duration::from_millis(300)),
            keep_alive_timeout: Some(Duration::from_millis(300)),
            max_connections: 0,
        }
    }

    #[tokio::test]
    async fn partial_headers_are_closed_after_the_headers_timeout() {
        let (mut server, port, _) =
            start(|_| "ok".into(), |s| s.set_connection_limits(quick_limits())).await;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\nX-Slow: ")
            .await
            .unwrap();
        assert!(closed_within(&mut stream, Duration::from_secs(5)).await);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_silent_connection_is_closed_after_the_headers_timeout() {
        // Not a single byte: HTTP-version detection waits for the first ones,
        // before hyper's own header timer has started.
        let (mut server, port, _) =
            start(|_| "ok".into(), |s| s.set_connection_limits(quick_limits())).await;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert!(closed_within(&mut stream, Duration::from_secs(5)).await);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_slow_body_is_answered_408() {
        let (mut server, port, calls) =
            start(|_| "ok".into(), |s| s.set_connection_limits(quick_limits())).await;
        let response = exchange(
            port,
            b"POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\nonly a few bytes",
            Duration::from_secs(5),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 408"), "{response}");
        assert!(response.contains("E_HTTP_REQUEST_TIMEOUT"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn an_idle_keep_alive_connection_is_closed() {
        let mut limits = quick_limits();
        limits.headers_timeout = Some(Duration::from_secs(30));
        let (mut server, port, _) =
            start(|_| "ok".into(), |s| s.set_connection_limits(limits)).await;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        // The keep-alive bound (300 ms) closes it long before the 30 s
        // header timeout would.
        assert!(closed_within(&mut stream, Duration::from_secs(5)).await);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn a_long_response_is_not_cut_by_the_keep_alive_bound() {
        // A handler busy for three times the idle bound: the request is in
        // flight, so the connection is not idle.
        let mut server = ReamServer::new(0);
        server.on_request(Arc::new(|_req| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(900)).await;
                ReamResponse::text(200, "slow")
            })
        }));
        server.set_connection_limits(quick_limits());
        server.listen().await.unwrap();
        let port = server.actual_port().await;
        let response = exchange(
            port,
            b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(body_of(&response), "slow");
        server.shutdown().await;
    }

    #[tokio::test]
    async fn the_connection_cap_holds_extra_clients_back() {
        let limits = ConnectionLimits {
            max_connections: 1,
            ..ConnectionLimits::default()
        };
        let (mut server, port, _) =
            start(|_| "ok".into(), |s| s.set_connection_limits(limits)).await;

        let mut first = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        first
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 1024];
        assert!(first.read(&mut buf).await.unwrap() > 0);

        // The second client sits in the backlog while the first holds the
        // only slot...
        let mut second = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        second
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let waiting = tokio::time::timeout(Duration::from_millis(300), second.read(&mut buf)).await;
        assert!(waiting.is_err(), "served past the connection cap");

        // ...and is served once it frees up.
        drop(first);
        let n = tokio::time::timeout(Duration::from_secs(5), second.read(&mut buf))
            .await
            .expect("served once a slot freed")
            .unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"));
        server.shutdown().await;
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

    fn header_map(lines: &[(&'static str, &[u8])]) -> hyper::HeaderMap {
        let mut map = hyper::HeaderMap::new();
        for (name, value) in lines {
            map.append(
                *name,
                hyper::header::HeaderValue::from_bytes(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn a_repeated_host_keeps_its_first_line() {
        let headers = collect_headers(&header_map(&[
            ("host", b"app.example.com"),
            ("host", b"evil.example.com"),
            ("authorization", b"Bearer first"),
            ("authorization", b"Bearer second"),
        ]));
        assert_eq!(headers["host"], "app.example.com");
        assert_eq!(headers["authorization"], "Bearer first");
    }

    #[test]
    fn other_repeated_headers_are_joined_like_node() {
        let headers = collect_headers(&header_map(&[
            ("accept", b"text/html"),
            ("accept", b"application/json"),
            ("x-forwarded-for", b"203.0.113.9"),
            ("x-forwarded-for", b"10.0.0.1"),
            ("cookie", b"a=1"),
            ("cookie", b"b=2"),
        ]));
        assert_eq!(headers["accept"], "text/html, application/json");
        assert_eq!(headers["x-forwarded-for"], "203.0.113.9, 10.0.0.1");
        assert_eq!(headers["cookie"], "a=1; b=2");
    }

    #[test]
    fn an_obs_text_header_value_is_read_as_latin1_not_dropped() {
        let headers = collect_headers(&header_map(&[("x-name", b"caf\xe9")]));
        assert_eq!(headers["x-name"], "caf\u{e9}");
    }

    #[test]
    fn the_host_comes_from_the_authority_when_no_host_line_was_sent() {
        let uri: hyper::Uri = "http://app.example.com:8443/h2?x=1".parse().unwrap();
        let headers = request_headers(&uri, &hyper::HeaderMap::new());
        assert_eq!(headers["host"], "app.example.com:8443");

        let uri: hyper::Uri = "http://user@[::1]/x".parse().unwrap();
        assert_eq!(
            request_headers(&uri, &hyper::HeaderMap::new())["host"],
            "[::1]"
        );
    }

    #[test]
    fn a_host_line_wins_over_the_authority_and_an_origin_form_adds_nothing() {
        let uri: hyper::Uri = "http://other.example.com/x".parse().unwrap();
        let headers = request_headers(&uri, &header_map(&[("host", b"app.example.com")]));
        assert_eq!(headers["host"], "app.example.com");

        let uri: hyper::Uri = "/x".parse().unwrap();
        assert!(!request_headers(&uri, &hyper::HeaderMap::new()).contains_key("host"));
    }

    #[tokio::test]
    async fn a_second_host_line_does_not_move_the_request() {
        let (mut server, port, _) = start(
            |req| req.headers.get("host").cloned().unwrap_or_default(),
            |_| {},
        )
        .await;
        let response = exchange(
            port,
            b"GET / HTTP/1.1\r\nHost: app.example.com\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n",
            Duration::from_secs(5),
        )
        .await;
        // hyper accepts a duplicate Host on HTTP/1.1; the first line is the
        // host, as in Node.
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(body_of(&response), "app.example.com");
        server.shutdown().await;
    }
}

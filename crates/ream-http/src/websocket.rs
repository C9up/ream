//! WebSocket connections (RFC 6455) on the HTTP/1.1 server.
//!
//! The upgrade is the JavaScript application's decision. A request that asks
//! for one is checked here first — its handshake headers and its `Origin` —
//! and then goes through the router, the middleware and the guards like any
//! other request. Only when the handler answers `101` with the id of a socket
//! it registered does this module complete the handshake and take over the
//! connection; any other answer is sent as a plain HTTP response and the
//! connection stays HTTP.
//!
//! Framing is tungstenite's: masking, fragmentation, control frames, UTF-8
//! validation of text and the close handshake. What is added here is what a
//! server exposed to the internet needs on top of it:
//!
//! * size limits on one frame and one message (`1009` past either);
//! * an idle bound — a ping after half of it without traffic, a close
//!   (`1001`) after all of it;
//! * a bound on what waits to be written to a client that reads slowly: past
//!   it the connection is closed (`1013`), never buffered further;
//! * a bound on what waits for JavaScript: past it the socket is not read
//!   until JavaScript catches up, so the client is slowed by TCP itself.
//!
//! WebSocket over HTTP/2 (RFC 8441, extended CONNECT) is not offered: an
//! HTTP/2 request never carries the HTTP/1.1 upgrade headers, so it reaches
//! the application as an ordinary request.

use crate::request::ReamRequest;
use crate::response::ReamResponse;
use futures_util::{SinkExt, StreamExt};
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

const MIB: usize = 1024 * 1024;

/// How long a close frame may take to be written, and the peer's own close
/// frame to come back, before the TCP connection is simply dropped.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a registered socket may wait for its handshake. A handler that
/// registered one and never answered leaves a stray; it is reaped after this.
const STRAY_TTL: Duration = Duration::from_secs(300);

/// What one queued outbound message costs on top of its payload, so a flood
/// of empty messages is bounded as well as a few large ones.
const MESSAGE_OVERHEAD: usize = 64;

/// Which `Origin` a browser may open a socket from.
///
/// A browser sends the cookies of the target site with a WebSocket handshake
/// whatever page started it, and the same-origin policy does not apply to
/// WebSockets: without this check any site could open an authenticated
/// socket in a visitor's name (cross-site WebSocket hijacking). A client that
/// sends no `Origin` at all is not a browser and is let through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginPolicy {
    /// The origin's host (and port) must be the request's `Host`.
    SameOrigin,
    /// Any origin.
    Any,
    /// One of these origins, compared as `scheme://host[:port]`.
    List(Vec<String>),
}

/// Bounds of every WebSocket connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSocketLimits {
    /// Largest payload of one incoming frame.
    pub max_frame_size: usize,
    /// Largest incoming message, all its fragments together.
    pub max_message_size: usize,
    /// Silence after which the connection is closed; a ping is sent at half
    /// of it. `None` never closes an idle connection.
    pub idle_timeout: Option<Duration>,
    /// Bytes allowed to wait for a slow client, and for a slow JavaScript
    /// consumer, per connection.
    pub max_buffered_bytes: usize,
    /// Which browser origins may connect.
    pub origins: OriginPolicy,
}

impl Default for WebSocketLimits {
    fn default() -> Self {
        Self {
            max_frame_size: MIB,
            max_message_size: MIB,
            idle_timeout: Some(Duration::from_secs(60)),
            max_buffered_bytes: 4 * MIB,
            origins: OriginPolicy::SameOrigin,
        }
    }
}

/// An incoming message's payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageData {
    Text(String),
    Binary(Vec<u8>),
}

/// What a socket reports to the application.
#[derive(Debug)]
pub enum WebSocketEvent {
    /// A complete message. `permit` holds its bytes against the socket's
    /// inbound budget until it is dropped — drop it once the message has
    /// been handed over, so the socket is read again.
    Message {
        id: String,
        data: MessageData,
        permit: InboundPermit,
    },
    /// The connection is over, sent once per socket that was registered.
    /// `code` is the peer's close code when it sent one, the code this server
    /// closed with otherwise, `1006` when the connection just dropped.
    Close {
        id: String,
        code: u16,
        reason: String,
    },
}

/// Where events go. Set once by the host (the NAPI layer).
pub type EventSink = Arc<dyn Fn(WebSocketEvent) + Send + Sync>;

/// Why a send was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    /// No socket has this id, or it is closed or closing.
    Closed,
    /// The message would take the socket past `max_buffered_bytes`; the
    /// connection is being closed with `1013`.
    Overflow,
}

#[derive(Debug)]
enum Outbound {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

/// Bytes delivered to the application and not yet consumed.
#[derive(Debug, Default)]
struct InboundBudget {
    pending: AtomicUsize,
    drained: Notify,
}

/// A delivered message's claim on its socket's inbound budget.
#[derive(Debug)]
pub struct InboundPermit {
    budget: Arc<InboundBudget>,
    bytes: usize,
}

impl Drop for InboundPermit {
    fn drop(&mut self) {
        self.budget.pending.fetch_sub(self.bytes, Ordering::AcqRel);
        self.budget.drained.notify_one();
    }
}

struct Socket {
    outbound: mpsc::UnboundedSender<Outbound>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<Outbound>>>,
    /// Bytes queued for the client and not yet written.
    buffered: AtomicUsize,
    /// No more sends: a close was asked for, or the connection is over.
    closing: AtomicBool,
    /// Set when the connection must be torn down without waiting for writes.
    kill: Notify,
    kill_code: Mutex<Option<(u16, String)>>,
    inbound: Arc<InboundBudget>,
    registered_at: std::time::Instant,
}

impl Socket {
    fn new() -> Self {
        let (outbound, receiver) = mpsc::unbounded_channel();
        Self {
            outbound,
            receiver: Mutex::new(Some(receiver)),
            buffered: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            kill: Notify::new(),
            kill_code: Mutex::new(None),
            inbound: Arc::new(InboundBudget::default()),
            registered_at: std::time::Instant::now(),
        }
    }

    fn kill(&self, code: u16, reason: &str) {
        self.closing.store(true, Ordering::Release);
        let mut slot = self
            .kill_code
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some((code, reason.to_string()));
        }
        drop(slot);
        self.kill.notify_one();
    }
}

#[derive(Default)]
struct RegistryInner {
    sockets: Mutex<HashMap<String, Arc<Socket>>>,
    sink: Mutex<Option<EventSink>>,
    limits: Mutex<WebSocketLimits>,
    /// Signalled whenever a socket leaves the map, for `shutdown`.
    left: Notify,
}

/// The sockets of one server. Cloning is cheap.
#[derive(Clone, Default)]
pub struct WebSocketRegistry {
    inner: Arc<RegistryInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl WebSocketRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the limits. Applies to connections upgraded afterwards.
    pub fn configure(&self, limits: WebSocketLimits) {
        *lock(&self.inner.limits) = limits;
    }

    pub fn limits(&self) -> WebSocketLimits {
        lock(&self.inner.limits).clone()
    }

    /// Where messages and closes are reported.
    pub fn set_event_sink(&self, sink: Option<EventSink>) {
        *lock(&self.inner.sink) = sink;
    }

    /// Reserve a socket for `id` ahead of the handshake. `false` when the id
    /// is taken. Messages sent before the handshake completes wait for it.
    pub fn register(&self, id: String) -> bool {
        let mut sockets = lock(&self.inner.sockets);
        sockets.retain(|_, socket| {
            lock(&socket.receiver).is_none() || socket.registered_at.elapsed() < STRAY_TTL
        });
        if sockets.contains_key(&id) {
            return false;
        }
        sockets.insert(id, Arc::new(Socket::new()));
        true
    }

    /// Forget a socket whose handshake will not happen (the handler answered
    /// something else, or threw). No close event: it never opened.
    pub fn discard(&self, id: &str) {
        let removed = lock(&self.inner.sockets).remove(id);
        if removed.is_some() {
            self.inner.left.notify_waiters();
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        lock(&self.inner.sockets).contains_key(id)
    }

    fn get(&self, id: &str) -> Option<Arc<Socket>> {
        lock(&self.inner.sockets).get(id).cloned()
    }

    /// Queue a text message. Returns the bytes now waiting for this client.
    pub fn send_text(&self, id: &str, text: String) -> Result<usize, SendError> {
        let len = text.len();
        self.send(id, Outbound::Text(text), len)
    }

    /// Queue a binary message. Returns the bytes now waiting for this client.
    pub fn send_binary(&self, id: &str, data: Vec<u8>) -> Result<usize, SendError> {
        let len = data.len();
        self.send(id, Outbound::Binary(data), len)
    }

    fn send(&self, id: &str, message: Outbound, len: usize) -> Result<usize, SendError> {
        let socket = self.get(id).ok_or(SendError::Closed)?;
        if socket.closing.load(Ordering::Acquire) {
            return Err(SendError::Closed);
        }
        let cost = len + MESSAGE_OVERHEAD;
        let max = self.limits().max_buffered_bytes;
        let buffered = socket.buffered.fetch_add(cost, Ordering::AcqRel) + cost;
        if buffered > max {
            socket.buffered.fetch_sub(cost, Ordering::AcqRel);
            socket.kill(1013, "send buffer full");
            return Err(SendError::Overflow);
        }
        if socket.outbound.send(message).is_err() {
            socket.buffered.fetch_sub(cost, Ordering::AcqRel);
            return Err(SendError::Closed);
        }
        Ok(buffered)
    }

    /// Bytes waiting for this client, `None` when there is no such socket.
    pub fn buffered_amount(&self, id: &str) -> Option<usize> {
        self.get(id)
            .map(|socket| socket.buffered.load(Ordering::Acquire))
    }

    /// Start the closing handshake once what is queued has been written.
    /// `false` when the socket is unknown or already closing.
    pub fn close(&self, id: &str, code: u16, reason: String) -> bool {
        let Some(socket) = self.get(id) else {
            return false;
        };
        if socket.closing.swap(true, Ordering::AcqRel) {
            return false;
        }
        socket.outbound.send(Outbound::Close(code, reason)).is_ok()
    }

    /// Close every socket with `1001` and wait for them to finish, at most
    /// [`CLOSE_TIMEOUT`]; the rest are dropped.
    pub async fn shutdown(&self) {
        let ids: Vec<String> = lock(&self.inner.sockets).keys().cloned().collect();
        for id in &ids {
            self.close(id, 1001, "server shutting down".into());
        }
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        loop {
            let left = self.inner.left.notified();
            if lock(&self.inner.sockets)
                .values()
                .all(|socket| lock(&socket.receiver).is_some())
            {
                // Only sockets that never opened are left: nothing to wait for.
                break;
            }
            if tokio::time::timeout_at(deadline, left).await.is_err() {
                break;
            }
        }
        // What did not finish in time is torn down; the application still
        // hears that each socket closed. Sockets that never opened go too,
        // silently: they had nothing to close.
        let remaining: Vec<(String, Arc<Socket>)> = lock(&self.inner.sockets).drain().collect();
        for (id, socket) in remaining {
            socket.kill(1001, "server shutting down");
            if lock(&socket.receiver).is_none() {
                self.emit(WebSocketEvent::Close {
                    id,
                    code: 1001,
                    reason: "server shutting down".into(),
                });
            }
        }
    }

    fn emit(&self, event: WebSocketEvent) {
        let sink = lock(&self.inner.sink).clone();
        if let Some(sink) = sink {
            sink(event);
        }
    }

    fn finish(&self, id: &str, code: u16, reason: String) {
        let removed = lock(&self.inner.sockets).remove(id);
        self.inner.left.notify_waiters();
        if removed.is_some() {
            self.emit(WebSocketEvent::Close {
                id: id.to_string(),
                code,
                reason,
            });
        }
    }
}

// ─── Handshake ──────────────────────────────────────────────

/// A request that asked for a WebSocket and passed the checks this server
/// makes before the application sees it.
pub(crate) struct Upgrade {
    accept: String,
    protocols: Vec<String>,
    on_upgrade: OnUpgrade,
}

fn header<'a>(req: &'a hyper::Request<hyper::body::Incoming>, name: &str) -> Option<&'a str> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

fn has_token(value: Option<&str>, token: &str) -> bool {
    value.is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case(token))
    })
}

fn refusal(status: u16, code: &str, message: &str) -> ReamResponse {
    ReamResponse::json(
        status,
        format!(r#"{{"error":{{"code":"{code}","message":"{message}"}}}}"#),
    )
}

/// `scheme://host[:port]` lower-cased, default port dropped.
fn normalize_origin(origin: &str) -> Option<String> {
    let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    let (scheme, authority) = origin.split_once("://")?;
    if authority.is_empty() || authority.contains('/') {
        return None;
    }
    let authority = match (scheme, authority.rsplit_once(':')) {
        ("https" | "wss", Some((host, "443"))) | ("http" | "ws", Some((host, "80"))) => host,
        _ => authority,
    };
    Some(format!("{scheme}://{authority}"))
}

fn origin_allowed(origin: Option<&str>, host: Option<&str>, policy: &OriginPolicy) -> bool {
    let Some(origin) = origin else {
        // No Origin: not a browser, so not a cross-site request either.
        return true;
    };
    let Some(origin) = normalize_origin(origin) else {
        // `null` (a sandboxed frame, a file) and anything unparsable.
        return matches!(policy, OriginPolicy::Any);
    };
    match policy {
        OriginPolicy::Any => true,
        OriginPolicy::List(allowed) => allowed
            .iter()
            .filter_map(|entry| normalize_origin(entry))
            .any(|entry| entry == origin),
        OriginPolicy::SameOrigin => {
            let Some(host) = host else { return false };
            let host = host.trim().to_ascii_lowercase();
            let Some((scheme, _)) = origin.split_once("://") else {
                return false;
            };
            normalize_origin(&format!("{scheme}://{host}")).is_some_and(|own| own == origin)
        }
    }
}

/// Look at a request for an upgrade to WebSocket.
///
/// `Ok(None)`: it does not ask for one. `Err`: it asks for one this server
/// refuses before the application is involved — a malformed handshake, an
/// unsupported version, a foreign origin.
pub(crate) fn check_upgrade(
    req: &mut hyper::Request<hyper::body::Incoming>,
    limits: &WebSocketLimits,
) -> Result<Option<Upgrade>, ReamResponse> {
    if !has_token(header(req, "upgrade"), "websocket") {
        return Ok(None);
    }
    if req.method() != hyper::Method::GET || req.version() != hyper::Version::HTTP_11 {
        return Err(refusal(
            400,
            "E_WEBSOCKET_BAD_HANDSHAKE",
            "A WebSocket handshake is an HTTP/1.1 GET",
        ));
    }
    if !has_token(header(req, "connection"), "upgrade") {
        return Err(refusal(
            400,
            "E_WEBSOCKET_BAD_HANDSHAKE",
            "Connection must include upgrade",
        ));
    }
    if header(req, "sec-websocket-version").map(str::trim) != Some("13") {
        let mut response = refusal(
            426,
            "E_WEBSOCKET_VERSION",
            "Only WebSocket version 13 is supported",
        );
        response
            .headers
            .insert("sec-websocket-version".into(), "13".into());
        return Err(response);
    }
    let key = header(req, "sec-websocket-key")
        .map(str::trim)
        .unwrap_or("");
    let decoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(key)
    };
    if decoded.map(|bytes| bytes.len()) != Ok(16) {
        return Err(refusal(
            400,
            "E_WEBSOCKET_BAD_HANDSHAKE",
            "Sec-WebSocket-Key must be 16 bytes in base64",
        ));
    }
    if !origin_allowed(header(req, "origin"), header(req, "host"), &limits.origins) {
        return Err(refusal(
            403,
            "E_WEBSOCKET_ORIGIN",
            "This origin may not open a WebSocket here",
        ));
    }
    let protocols = header(req, "sec-websocket-protocol")
        .map(|value| {
            value
                .split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    Ok(Some(Upgrade {
        accept,
        protocols,
        on_upgrade: hyper::upgrade::on(req),
    }))
}

/// Mark the request the application receives.
pub(crate) fn mark_request(request: &mut ReamRequest) {
    request.websocket = true;
}

/// What the server does with the application's answer to an upgrade request.
pub(crate) enum Answer {
    /// Switch protocols: send this `101`, then run the socket.
    Accept(ReamResponse, Upgrade, String),
    /// Send this response as plain HTTP.
    Http(ReamResponse),
}

/// Decide on the application's answer. A `101` with a registered socket id
/// becomes the handshake response; anything else is plain HTTP, and a socket
/// registered for it is forgotten.
pub(crate) fn answer(
    mut response: ReamResponse,
    upgrade: Option<Upgrade>,
    registry: &WebSocketRegistry,
) -> Answer {
    let Some(id) = response.websocket_id.take().map(String::from) else {
        if response.status == 101 {
            return Answer::Http(refusal(
                500,
                "E_WEBSOCKET_NOT_REGISTERED",
                "A 101 answer needs a registered WebSocket",
            ));
        }
        return Answer::Http(response);
    };
    let accepted = response.status == 101 && registry.contains(&id);
    let Some(upgrade) = upgrade.filter(|_| accepted) else {
        registry.discard(&id);
        if response.status == 101 {
            return Answer::Http(refusal(
                500,
                "E_WEBSOCKET_NOT_UPGRADE",
                "Only a WebSocket handshake request can be answered 101",
            ));
        }
        return Answer::Http(response);
    };
    // The subprotocol the application chose must be one the client offered;
    // anything else would make a conforming client fail the connection.
    let chosen = response
        .headers
        .keys()
        .find(|name| name.eq_ignore_ascii_case("sec-websocket-protocol"))
        .cloned();
    if let Some(name) = chosen {
        let offered = response
            .headers
            .get(&name)
            .is_some_and(|value| upgrade.protocols.iter().any(|p| p == value));
        if !offered {
            registry.discard(&id);
            return Answer::Http(refusal(
                500,
                "E_WEBSOCKET_PROTOCOL",
                "The chosen subprotocol was not offered by the client",
            ));
        }
    }
    response.body.clear();
    response.headers.retain(|name, _| {
        !["content-length", "content-type", "transfer-encoding"]
            .iter()
            .any(|h| name.eq_ignore_ascii_case(h))
    });
    response
        .headers
        .insert("upgrade".into(), "websocket".into());
    response
        .headers
        .insert("connection".into(), "Upgrade".into());
    response
        .headers
        .insert("sec-websocket-accept".into(), upgrade.accept.clone());
    Answer::Accept(response, upgrade, id)
}

// ─── Connection ─────────────────────────────────────────────

fn close_message(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.to_string().into(),
    }))
}

/// Drive one socket after the `101` has been sent, until it closes.
/// `slot` is the connection-cap permit: a socket counts as a connection.
pub(crate) async fn run(
    registry: WebSocketRegistry,
    id: String,
    upgrade: Upgrade,
    slot: Option<Arc<OwnedSemaphorePermit>>,
) {
    let _slot = slot;
    let Some(socket) = registry.get(&id) else {
        return;
    };
    let receiver = lock(&socket.receiver).take();
    let Some(mut outbound) = receiver else {
        return;
    };
    let upgraded = match upgrade.on_upgrade.await {
        Ok(upgraded) => upgraded,
        Err(_) => {
            registry.finish(&id, 1006, String::new());
            return;
        }
    };
    let limits = registry.limits();
    let config = WebSocketConfig::default()
        .max_frame_size(Some(limits.max_frame_size))
        .max_message_size(Some(limits.max_message_size))
        // What tungstenite may hold beyond the socket: one message past its
        // write target. The application's backlog is bounded before it.
        .max_write_buffer_size(128 * 1024 + limits.max_message_size.max(limits.max_buffered_bytes));
    let stream =
        WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
    let (code, reason) = drive(&registry, &id, &socket, stream, &mut outbound, &limits).await;
    socket.closing.store(true, Ordering::Release);
    registry.finish(&id, code, reason);
}

/// How the connection ended, as reported to the application.
type Ending = (u16, String);

async fn drive<S>(
    registry: &WebSocketRegistry,
    id: &str,
    socket: &Arc<Socket>,
    stream: WebSocketStream<S>,
    outbound: &mut mpsc::UnboundedReceiver<Outbound>,
    limits: &WebSocketLimits,
) -> Ending
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut incoming) = stream.split();
    let mut last_seen = Instant::now();
    let mut pinged = false;
    // Set once this side has sent its close frame: (code, reason, deadline
    // for the peer's reply).
    let mut sent_close: Option<(u16, String, Instant)> = None;
    let mut outbound_open = true;

    loop {
        let idle_at = limits.idle_timeout.map(|idle| {
            if pinged {
                last_seen + idle
            } else {
                last_seen + idle / 2
            }
        });
        let deadline = match (&sent_close, idle_at) {
            (Some((_, _, at)), _) => Some(*at),
            (None, at) => at,
        };
        let budget = &socket.inbound;
        let can_read = budget.pending.load(Ordering::Acquire) < limits.max_buffered_bytes;

        tokio::select! {
            biased;

            _ = socket.kill.notified() => {
                let (code, reason) = lock(&socket.kill_code)
                    .clone()
                    .unwrap_or((1001, String::new()));
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, sink.send(close_message(code, &reason))).await;
                return (code, reason);
            }

            message = outbound.recv(), if outbound_open && sent_close.is_none() => {
                let Some(message) = message else {
                    outbound_open = false;
                    continue;
                };
                let (frame, cost) = match message {
                    Outbound::Text(text) => {
                        let cost = text.len() + MESSAGE_OVERHEAD;
                        (Message::Text(text.into()), cost)
                    }
                    Outbound::Binary(data) => {
                        let cost = data.len() + MESSAGE_OVERHEAD;
                        (Message::Binary(data.into()), cost)
                    }
                    Outbound::Close(code, reason) => {
                        let frame = close_message(code, &reason);
                        sent_close = Some((code, reason, Instant::now() + CLOSE_TIMEOUT));
                        (frame, 0)
                    }
                };
                // A write to a client that does not read blocks here; a kill
                // (backlog past its bound, shutdown) still gets through.
                let written = tokio::select! {
                    biased;
                    _ = socket.kill.notified() => {
                        socket.kill.notify_one();
                        continue;
                    }
                    result = sink.send(frame) => result,
                };
                socket.buffered.fetch_sub(cost, Ordering::AcqRel);
                if written.is_err() {
                    return (1006, String::new());
                }
            }

            frame = incoming.next(), if can_read => {
                match frame {
                    None => {
                        return match sent_close {
                            Some((code, reason, _)) => (code, reason),
                            None => (1006, String::new()),
                        };
                    }
                    Some(Ok(message)) => {
                        last_seen = Instant::now();
                        pinged = false;
                        match message {
                            Message::Text(text) => {
                                deliver(registry, id, budget, MessageData::Text(text.as_str().to_string()));
                            }
                            Message::Binary(data) => {
                                deliver(registry, id, budget, MessageData::Binary(data.to_vec()));
                            }
                            Message::Close(frame) => {
                                // tungstenite has queued the reply; write it out.
                                let _ = tokio::time::timeout(CLOSE_TIMEOUT, sink.flush()).await;
                                if let Some((code, reason, _)) = sent_close {
                                    return (code, reason);
                                }
                                return match frame {
                                    Some(frame) => (u16::from(frame.code), frame.reason.as_str().to_string()),
                                    None => (1005, String::new()),
                                };
                            }
                            // Pings are answered by tungstenite; flush the pong.
                            Message::Ping(_) => {
                                let _ = sink.flush().await;
                            }
                            Message::Pong(_) | Message::Frame(_) => {}
                        }
                    }
                    Some(Err(error)) => {
                        if let Some((code, reason, _)) = sent_close {
                            // We were closing anyway: whatever ended it, the
                            // close is ours.
                            return (code, reason);
                        }
                        let (code, reason) = match error {
                            // The peer dropped the TCP connection without a
                            // close frame: abnormal, nothing to send.
                            WsError::Protocol(
                                tokio_tungstenite::tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
                            ) => return (1006, String::new()),
                            WsError::Capacity(_) => (1009, "message too big"),
                            WsError::Utf8(_) => (1007, "invalid UTF-8"),
                            WsError::Protocol(_) | WsError::AttackAttempt => (1002, "protocol error"),
                            WsError::ConnectionClosed | WsError::AlreadyClosed => {
                                return match sent_close {
                                    Some((code, reason, _)) => (code, reason),
                                    None => (1006, String::new()),
                                };
                            }
                            _ => return (1006, String::new()),
                        };
                        let _ = tokio::time::timeout(CLOSE_TIMEOUT, sink.send(close_message(code, reason))).await;
                        return (code, reason.to_string());
                    }
                }
            }

            _ = budget.drained.notified(), if !can_read => {}

            _ = sleep_until(deadline), if deadline.is_some() => {
                if let Some((code, reason, _)) = sent_close {
                    // The peer never answered our close frame.
                    return (code, reason);
                }
                if pinged {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, sink.send(close_message(1001, "idle timeout"))).await;
                    return (1001, "idle timeout".into());
                }
                pinged = true;
                let ping = tokio::select! {
                    biased;
                    _ = socket.kill.notified() => {
                        socket.kill.notify_one();
                        continue;
                    }
                    result = sink.send(Message::Ping(Vec::new().into())) => result,
                };
                if ping.is_err() {
                    return (1006, String::new());
                }
            }
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn deliver(registry: &WebSocketRegistry, id: &str, budget: &Arc<InboundBudget>, data: MessageData) {
    let bytes = match &data {
        MessageData::Text(text) => text.len(),
        MessageData::Binary(data) => data.len(),
    } + MESSAGE_OVERHEAD;
    budget.pending.fetch_add(bytes, Ordering::AcqRel);
    let permit = InboundPermit {
        budget: budget.clone(),
        bytes,
    };
    registry.emit(WebSocketEvent::Message {
        id: id.to_string(),
        data,
        permit,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_compare_without_default_ports_or_case() {
        assert_eq!(
            normalize_origin("HTTPS://App.Test:443/").as_deref(),
            Some("https://app.test")
        );
        assert_eq!(
            normalize_origin("http://app.test:8080").as_deref(),
            Some("http://app.test:8080")
        );
        assert_eq!(normalize_origin("null"), None);
        assert_eq!(normalize_origin("https://app.test/path"), None);
    }

    #[test]
    fn same_origin_matches_the_host_header() {
        let same = OriginPolicy::SameOrigin;
        assert!(origin_allowed(
            Some("http://localhost:3333"),
            Some("localhost:3333"),
            &same
        ));
        assert!(origin_allowed(
            Some("https://app.test"),
            Some("app.test"),
            &same
        ));
        assert!(!origin_allowed(
            Some("https://evil.test"),
            Some("app.test"),
            &same
        ));
        assert!(!origin_allowed(
            Some("http://localhost:4444"),
            Some("localhost:3333"),
            &same
        ));
        assert!(!origin_allowed(Some("null"), Some("app.test"), &same));
        assert!(origin_allowed(None, Some("app.test"), &same));
        assert!(!origin_allowed(Some("https://app.test"), None, &same));
    }

    #[test]
    fn a_list_names_each_origin() {
        let list = OriginPolicy::List(vec![
            "https://app.test".into(),
            "http://localhost:5173".into(),
        ]);
        assert!(origin_allowed(
            Some("https://app.test:443"),
            Some("api.test"),
            &list
        ));
        assert!(origin_allowed(
            Some("http://localhost:5173"),
            Some("api.test"),
            &list
        ));
        assert!(!origin_allowed(
            Some("https://other.test"),
            Some("api.test"),
            &list
        ));
        assert!(origin_allowed(Some("null"), None, &OriginPolicy::Any));
    }

    #[test]
    fn a_send_past_the_backlog_bound_kills_the_socket() {
        let registry = WebSocketRegistry::new();
        registry.configure(WebSocketLimits {
            max_buffered_bytes: 1000,
            ..WebSocketLimits::default()
        });
        assert!(registry.register("a".into()));
        assert!(!registry.register("a".into()));
        assert_eq!(
            registry.send_text("a", "x".repeat(500)),
            Ok(500 + MESSAGE_OVERHEAD)
        );
        assert_eq!(
            registry.send_text("a", "x".repeat(500)),
            Err(SendError::Overflow)
        );
        // Closing: nothing more is accepted.
        assert_eq!(registry.send_text("a", "x".into()), Err(SendError::Closed));
        assert_eq!(
            registry.send_text("missing", "x".into()),
            Err(SendError::Closed)
        );
    }

    #[test]
    fn close_is_accepted_once() {
        let registry = WebSocketRegistry::new();
        registry.register("a".into());
        assert!(registry.close("a", 1000, String::new()));
        assert!(!registry.close("a", 1000, String::new()));
        assert_eq!(registry.send_text("a", "x".into()), Err(SendError::Closed));
    }
}

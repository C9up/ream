//! WebSocket connections end to end: a real server, a real client, each limit.

use futures_util::{SinkExt, StreamExt};
use ream_http::{
    MessageData, OriginPolicy, ReamRequest, ReamResponse, ReamServer, SendError, WebSocketEvent,
    WebSocketLimits, WebSocketRegistry,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// What the test sees of the server side.
enum Seen {
    Message(MessageData),
    Close(u16, String),
}

struct Harness {
    port: u16,
    registry: WebSocketRegistry,
    events: mpsc::UnboundedReceiver<Seen>,
    handled: Arc<AtomicUsize>,
    server: ReamServer,
    /// Permits kept alive when the test holds inbound messages back.
    held: Arc<Mutex<Vec<ream_http::InboundPermit>>>,
}

/// How the handler answers an upgrade request.
#[derive(Clone)]
enum Plan {
    /// Register a socket and answer 101; echo every message back.
    AcceptEcho,
    /// Register and answer 101 choosing this subprotocol.
    AcceptProtocol(&'static str),
    /// Answer this status, no socket.
    Refuse(u16),
    /// Answer 101 without registering anything.
    UnregisteredSwitch,
    /// Accept, and keep every inbound permit instead of consuming it.
    AcceptHolding,
}

async fn start(limits: WebSocketLimits, plan: Plan) -> Harness {
    let mut server = ReamServer::new(0);
    let registry = server.websockets();
    registry.configure(limits);
    let (tx, events) = mpsc::unbounded_channel();
    let held: Arc<Mutex<Vec<ream_http::InboundPermit>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let echo = registry.clone();
        let echoing = !matches!(plan, Plan::AcceptHolding);
        let held = held.clone();
        registry.set_event_sink(Some(Arc::new(move |event| match event {
            WebSocketEvent::Message { id, data, permit } => {
                if echoing {
                    let _ = match &data {
                        MessageData::Text(text) => echo.send_text(&id, text.clone()),
                        MessageData::Binary(bytes) => echo.send_binary(&id, bytes.clone()),
                    };
                    drop(permit);
                } else {
                    held.lock().unwrap().push(permit);
                }
                let _ = tx.send(Seen::Message(data));
            }
            WebSocketEvent::Close { code, reason, .. } => {
                let _ = tx.send(Seen::Close(code, reason));
            }
        })));
    }
    let handled = Arc::new(AtomicUsize::new(0));
    let next = Arc::new(AtomicUsize::new(0));
    {
        let registry = registry.clone();
        let handled = handled.clone();
        server.on_request(Arc::new(move |req: ReamRequest| {
            let registry = registry.clone();
            let handled = handled.clone();
            let plan = plan.clone();
            let id = format!("ws-{}", next.fetch_add(1, Ordering::SeqCst));
            Box::pin(async move {
                handled.fetch_add(1, Ordering::SeqCst);
                if !req.websocket {
                    return ReamResponse::text(426, "upgrade required");
                }
                let mut response = ReamResponse {
                    status: 101,
                    ..ReamResponse::default()
                };
                match plan {
                    Plan::Refuse(status) => return ReamResponse::text(status, "no"),
                    Plan::UnregisteredSwitch => return response,
                    Plan::AcceptProtocol(protocol) => {
                        response
                            .headers
                            .insert("sec-websocket-protocol".into(), protocol.into());
                    }
                    Plan::AcceptEcho | Plan::AcceptHolding => {}
                }
                assert!(registry.register(id.clone()));
                response.websocket_id = Some(id.into_boxed_str());
                response
            })
        }));
    }
    server.listen().await.unwrap();
    let port = server.actual_port().await;
    Harness {
        port,
        registry,
        events,
        handled,
        server,
        held,
    }
}

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(port: u16, headers: &[(&str, &str)]) -> Result<Client, WsError> {
    let mut request = format!("ws://127.0.0.1:{port}/socket")
        .into_client_request()
        .unwrap();
    for (name, value) in headers {
        request.headers_mut().insert(
            hyper::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    // The client may send what the server must refuse.
    let config = WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    tokio_tungstenite::connect_async_with_config(request, Some(config), false)
        .await
        .map(|(stream, _)| stream)
}

fn status_of(error: WsError) -> u16 {
    match error {
        WsError::Http(response) => response.status().as_u16(),
        other => panic!("expected an HTTP refusal, got {other:?}"),
    }
}

async fn next_event(events: &mut mpsc::UnboundedReceiver<Seen>) -> Seen {
    tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("an event in time")
        .expect("the channel open")
}

async fn close_event(events: &mut mpsc::UnboundedReceiver<Seen>) -> (u16, String) {
    loop {
        if let Seen::Close(code, reason) = next_event(events).await {
            return (code, reason);
        }
    }
}

/// The close code the client receives.
async fn client_close_code(client: &mut Client) -> Option<u16> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let frame = tokio::time::timeout_at(deadline, client.next())
            .await
            .expect("the server closes in time");
        match frame {
            Some(Ok(Message::Close(frame))) => return frame.map(|f| u16::from(f.code)),
            Some(Ok(_)) => continue,
            _ => return None,
        }
    }
}

#[tokio::test]
async fn messages_travel_both_ways_and_a_client_close_is_reported() {
    let mut h = start(WebSocketLimits::default(), Plan::AcceptEcho).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    client.send(Message::Text("héllo".into())).await.unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        Message::Text("héllo".into())
    );
    client
        .send(Message::Binary(vec![0, 255, 1].into()))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        Message::Binary(vec![0, 255, 1].into())
    );
    match next_event(&mut h.events).await {
        Seen::Message(MessageData::Text(text)) => assert_eq!(text, "héllo"),
        _ => panic!("the text message first"),
    }
    client
        .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: CloseCode::from(4001),
            reason: "done".into(),
        }))
        .await
        .unwrap();
    assert_eq!(close_event(&mut h.events).await, (4001, "done".into()));
    h.server.shutdown().await;
}

#[tokio::test]
async fn an_application_refusal_is_plain_http_and_opens_nothing() {
    let h = start(WebSocketLimits::default(), Plan::Refuse(401)).await;
    let error = connect(h.port, &[]).await.unwrap_err();
    assert_eq!(status_of(error), 401);
    assert_eq!(h.handled.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_101_without_a_registered_socket_is_a_500() {
    let h = start(WebSocketLimits::default(), Plan::UnregisteredSwitch).await;
    let error = connect(h.port, &[]).await.unwrap_err();
    assert_eq!(status_of(error), 500);
}

#[tokio::test]
async fn a_foreign_origin_is_refused_before_the_application() {
    let h = start(WebSocketLimits::default(), Plan::AcceptEcho).await;
    let error = connect(h.port, &[("origin", "https://evil.test")])
        .await
        .unwrap_err();
    assert_eq!(status_of(error), 403);
    assert_eq!(h.handled.load(Ordering::SeqCst), 0);
    // Same origin as the Host the client sends.
    let own = format!("http://127.0.0.1:{}", h.port);
    assert!(connect(h.port, &[("origin", &own)]).await.is_ok());
    // Without an Origin: not a browser.
    assert!(connect(h.port, &[]).await.is_ok());
}

#[tokio::test]
async fn an_allow_list_lets_the_named_origins_in() {
    let limits = WebSocketLimits {
        origins: OriginPolicy::List(vec!["https://app.test".into()]),
        ..WebSocketLimits::default()
    };
    let h = start(limits, Plan::AcceptEcho).await;
    assert!(connect(h.port, &[("origin", "https://app.test")])
        .await
        .is_ok());
    let own = format!("http://127.0.0.1:{}", h.port);
    assert_eq!(
        status_of(connect(h.port, &[("origin", &own)]).await.unwrap_err()),
        403
    );
}

#[tokio::test]
async fn an_unsupported_version_is_answered_426_with_the_supported_one() {
    let h = start(WebSocketLimits::default(), Plan::AcceptEcho).await;
    let error = connect(h.port, &[("sec-websocket-version", "8")])
        .await
        .unwrap_err();
    match error {
        WsError::Http(response) => {
            assert_eq!(response.status().as_u16(), 426);
            assert_eq!(response.headers()["sec-websocket-version"], "13");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(h.handled.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_message_over_the_limit_closes_with_1009() {
    let limits = WebSocketLimits {
        max_message_size: 1000,
        max_frame_size: 1000,
        ..WebSocketLimits::default()
    };
    let mut h = start(limits, Plan::AcceptEcho).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    client
        .send(Message::Text("x".repeat(1001).into()))
        .await
        .unwrap();
    assert_eq!(client_close_code(&mut client).await, Some(1009));
    assert_eq!(close_event(&mut h.events).await.0, 1009);
}

#[tokio::test]
async fn a_fragmented_message_over_the_limit_closes_with_1009() {
    let limits = WebSocketLimits {
        max_message_size: 1000,
        max_frame_size: 600,
        ..WebSocketLimits::default()
    };
    let mut h = start(limits, Plan::AcceptEcho).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    // Two frames of 500: each under the frame limit, together over the message one.
    use tokio_tungstenite::tungstenite::protocol::frame::{
        coding::{Data, OpCode},
        Frame, FrameHeader,
    };
    let first = Frame::from_payload(
        FrameHeader {
            is_final: false,
            opcode: OpCode::Data(Data::Text),
            ..FrameHeader::default()
        },
        "x".repeat(500).into_bytes().into(),
    );
    let second = Frame::from_payload(
        FrameHeader {
            is_final: true,
            opcode: OpCode::Data(Data::Continue),
            ..FrameHeader::default()
        },
        "x".repeat(501).into_bytes().into(),
    );
    client.send(Message::Frame(first)).await.unwrap();
    client.send(Message::Frame(second)).await.unwrap();
    assert_eq!(client_close_code(&mut client).await, Some(1009));
    assert_eq!(close_event(&mut h.events).await.0, 1009);
}

#[tokio::test]
async fn a_silent_client_is_pinged_then_closed_with_1001() {
    let limits = WebSocketLimits {
        idle_timeout: Some(Duration::from_millis(400)),
        ..WebSocketLimits::default()
    };
    let mut h = start(limits, Plan::AcceptEcho).await;
    // A client that never reads never answers the ping.
    let _silent = connect(h.port, &[]).await.unwrap();
    let started = tokio::time::Instant::now();
    assert_eq!(
        close_event(&mut h.events).await,
        (1001, "idle timeout".into())
    );
    assert!(started.elapsed() >= Duration::from_millis(350));
}

#[tokio::test]
async fn a_client_answering_pings_stays_open() {
    let limits = WebSocketLimits {
        idle_timeout: Some(Duration::from_millis(300)),
        ..WebSocketLimits::default()
    };
    let mut h = start(limits, Plan::AcceptEcho).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    // Reading answers each ping (tungstenite queues the pong and flushes it).
    let until = tokio::time::Instant::now() + Duration::from_millis(1200);
    let mut pings = 0;
    while let Ok(frame) = tokio::time::timeout_at(until, client.next()).await {
        match frame {
            Some(Ok(Message::Ping(_))) => pings += 1,
            other => panic!("only pings while the client answers them, got {other:?}"),
        }
    }
    assert!(pings >= 2, "pinged {pings} times in four idle halves");
    client
        .send(Message::Text("still here".into()))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        Message::Text("still here".into())
    );
    assert!(matches!(next_event(&mut h.events).await, Seen::Message(..)));
}

#[tokio::test]
async fn a_client_that_does_not_read_is_closed_with_1013_not_buffered() {
    let limits = WebSocketLimits {
        max_buffered_bytes: 256 * 1024,
        idle_timeout: None,
        ..WebSocketLimits::default()
    };
    let mut h = start(limits, Plan::AcceptEcho).await;
    let client = connect(h.port, &[]).await.unwrap();
    // Find the socket's id: the first registered is ws-0.
    let id = "ws-0";
    let chunk = "y".repeat(64 * 1024);
    let mut sent = 0usize;
    let overflow = loop {
        match h.registry.send_text(id, chunk.clone()) {
            Ok(_) => sent += chunk.len(),
            Err(error) => break error,
        }
        assert!(sent < 512 * 1024 * 1024, "the backlog bound never held");
        tokio::task::yield_now().await;
    };
    assert_eq!(overflow, SendError::Overflow);
    assert_eq!(close_event(&mut h.events).await.0, 1013);
    drop(client);
}

#[tokio::test]
async fn javascript_slower_than_the_client_pauses_reading() {
    let limits = WebSocketLimits {
        max_buffered_bytes: 1000,
        ..WebSocketLimits::default()
    };
    let mut h = start(limits, Plan::AcceptHolding).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    for _ in 0..10 {
        client
            .send(Message::Text("z".repeat(400).into()))
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut delivered = 0;
    while let Ok(Seen::Message(..)) = h.events.try_recv() {
        delivered += 1;
    }
    // (400 + overhead) * 3 > 1000: reading stops at the third message.
    assert!(
        delivered <= 3,
        "delivered {delivered} while JavaScript held them"
    );
    h.held.lock().unwrap().clear();
    loop {
        if let Seen::Message(..) = next_event(&mut h.events).await {
            delivered += 1;
            h.held.lock().unwrap().clear();
            if delivered == 10 {
                break;
            }
        }
    }
}

#[tokio::test]
async fn a_server_close_reaches_the_client_with_its_code() {
    let mut h = start(WebSocketLimits::default(), Plan::AcceptEcho).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    // Wait until the socket is open, then close it from the server side.
    client.send(Message::Text("hi".into())).await.unwrap();
    client.next().await.unwrap().unwrap();
    assert!(h.registry.close("ws-0", 4000, "bye".into()));
    assert_eq!(client_close_code(&mut client).await, Some(4000));
    assert_eq!(close_event(&mut h.events).await, (4000, "bye".into()));
    assert_eq!(
        h.registry.send_text("ws-0", "late".into()),
        Err(SendError::Closed)
    );
}

#[tokio::test]
async fn shutdown_closes_open_sockets_with_1001() {
    let mut h = start(WebSocketLimits::default(), Plan::AcceptEcho).await;
    let mut client = connect(h.port, &[]).await.unwrap();
    client.send(Message::Text("hi".into())).await.unwrap();
    client.next().await.unwrap().unwrap();
    let reading = tokio::spawn(async move { client_close_code(&mut client).await });
    h.server.shutdown().await;
    assert_eq!(reading.await.unwrap(), Some(1001));
    assert_eq!(close_event(&mut h.events).await.0, 1001);
}

#[tokio::test]
async fn the_chosen_subprotocol_must_be_one_the_client_offered() {
    let h = start(WebSocketLimits::default(), Plan::AcceptProtocol("chat.v2")).await;
    let mut request = format!("ws://127.0.0.1:{}/socket", h.port)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        "chat.v1, chat.v2".parse().unwrap(),
    );
    let (_, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "chat.v2");

    let error = connect(h.port, &[("sec-websocket-protocol", "chat.v1")])
        .await
        .unwrap_err();
    assert_eq!(status_of(error), 500);
}

#[tokio::test]
async fn a_plain_get_to_the_same_path_stays_http() {
    let h = start(WebSocketLimits::default(), Plan::AcceptEcho).await;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", h.port))
        .await
        .unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream
        .write_all(b"GET /socket HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 426"), "{response}");
}

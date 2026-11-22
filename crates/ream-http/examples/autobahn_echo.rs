//! An echo server for the Autobahn WebSocket test suite (fuzzingclient).
//!
//!   cargo run --release -p ream-http --example autobahn_echo -- 9001
//!
//! Limits are raised to what the suite sends (its 9.x cases go to 16 MiB);
//! everything else is the server as an application gets it.

use ream_http::{
    MessageData, OriginPolicy, ReamRequest, ReamResponse, ReamServer, WebSocketEvent,
    WebSocketLimits,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let port = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(9001);
    let mut server = ReamServer::new(port).with_host([0, 0, 0, 0]);
    let registry = server.websockets();
    registry.configure(WebSocketLimits {
        max_frame_size: 64 << 20,
        max_message_size: 64 << 20,
        idle_timeout: None,
        max_buffered_bytes: 256 << 20,
        origins: OriginPolicy::Any,
    });
    let echo = registry.clone();
    registry.set_event_sink(Some(Arc::new(move |event| {
        if let WebSocketEvent::Message { id, data, permit } = event {
            let _ = match data {
                MessageData::Text(text) => echo.send_text(&id, text),
                MessageData::Binary(bytes) => echo.send_binary(&id, bytes),
            };
            drop(permit);
        }
    })));
    let next = Arc::new(AtomicU64::new(0));
    let accept = registry.clone();
    server.on_request(Arc::new(move |req: ReamRequest| {
        let id = format!("ab-{}", next.fetch_add(1, Ordering::SeqCst));
        let registry = accept.clone();
        Box::pin(async move {
            if !req.websocket || !registry.register(id.clone()) {
                return ReamResponse::text(426, "upgrade required");
            }
            ReamResponse {
                status: 101,
                websocket_id: Some(id.into_boxed_str()),
                ..ReamResponse::default()
            }
        })
    }));
    server.listen().await.expect("listen");
    eprintln!("autobahn echo on {}", server.actual_port().await);
    std::future::pending::<()>().await;
}

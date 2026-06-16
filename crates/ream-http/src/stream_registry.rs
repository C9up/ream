//! Streaming-response registry for long-lived bodies (SSE, chunked downloads).
//!
//! The buffered request/response path in [`server`](crate::server) covers the
//! common case — TS handler returns a full body, Rust ships it. SSE breaks
//! that contract: the handler must keep the connection open and push chunks
//! as events happen. To keep the existing path unchanged, streaming is
//! grafted on as a sidecar:
//!
//!   1. The JS handler generates a stream id (UUID), calls
//!      [`StreamRegistry::register`] **before** returning, and ships the id
//!      back inside `NapiResponse.stream_id`.
//!   2. The hyper response builder sees the id, looks up the matching
//!      receiver, and feeds a hyper streaming body from it. Hyper emits
//!      response headers immediately and polls the body for frames as JS
//!      pushes them.
//!   3. JS calls `HyperServer.writeStream(id, chunk)` repeatedly. Each
//!      call routes through [`StreamRegistry::send_chunk`] which queues a
//!      `Bytes` frame on the bounded mpsc channel.
//!   4. JS calls `HyperServer.closeStream(id)` (or drops its writer) — the
//!      sender is removed, the receiver sees EOF, hyper closes the body.
//!   5. If the **client** disconnects first, hyper drops the body, which
//!      drops the receiver. `sender.closed()` resolves, and any registered
//!      disconnect callback fires so the JS layer can clean up its own
//!      bookkeeping (SSE client map, subscription index, etc.).
//!
//! The registry holds one entry per active stream. A 5-min idle GC pass
//! reaps strays in case JS forgets to close (e.g., handler panic between
//! `register` and the response return — rare but observable in tests).

use bytes::Bytes;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};

/// Bounded sender capacity — SSE bursts are bounded by the rate at which
/// the TS layer pushes events; 256 frames buffered is plenty without
/// pinning memory on a slow consumer.
const STREAM_BUFFER_FRAMES: usize = 256;

/// Maximum lifetime for a registered-but-never-served stream. Strays
/// (handler panicked between `register` and returning) are reaped after
/// this so the registry doesn't leak.
const STRAY_TTL: Duration = Duration::from_secs(300);

pub type StreamId = String;

/// Chunk written by JS, polled by the hyper streaming body.
#[derive(Debug)]
pub struct StreamChunk {
    pub bytes: Bytes,
}

/// One side of a registered stream as held by the registry. The receiver
/// is taken once by the response builder; the sender stays in the entry
/// so JS can push chunks for the lifetime of the connection.
pub struct StreamEntry {
    sender: mpsc::Sender<StreamChunk>,
    receiver: Mutex<Option<mpsc::Receiver<StreamChunk>>>,
    created_at: Instant,
}

/// Shared registry. Cloning is cheap (Arc).
#[derive(Clone, Default)]
pub struct StreamRegistry {
    inner: Arc<Mutex<HashMap<StreamId, Arc<StreamEntry>>>>,
}

impl StreamRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve a slot for `stream_id`. Returns `false` if the id is
    /// already registered (JS bug — caller must pick a fresh UUID).
    pub async fn register(&self, stream_id: StreamId) -> bool {
        let mut map = self.inner.lock().await;
        if map.contains_key(&stream_id) {
            return false;
        }
        let (sender, receiver) = mpsc::channel(STREAM_BUFFER_FRAMES);
        let entry = Arc::new(StreamEntry {
            sender,
            receiver: Mutex::new(Some(receiver)),
            created_at: Instant::now(),
        });
        map.insert(stream_id, entry);
        true
    }

    /// Pull the receiver out of the registry. Called once by the response
    /// builder when the streaming body is created. Subsequent calls
    /// return `None` (each receiver can only be consumed once).
    pub async fn take_receiver(
        &self,
        stream_id: &str,
    ) -> Option<mpsc::Receiver<StreamChunk>> {
        let map = self.inner.lock().await;
        let entry = map.get(stream_id)?.clone();
        drop(map);
        let mut rx_slot = entry.receiver.lock().await;
        rx_slot.take()
    }

    /// Push a chunk onto the stream. Returns `false` when the receiver
    /// has been dropped (client disconnected, stream closed) so the JS
    /// caller can bail out of its push loop without polling.
    ///
    /// Uses `try_send` so a JS call never awaits on a full channel — the
    /// chunk is dropped silently in that case. SSE is fire-and-forget by
    /// design; back-pressure on a slow client is the consumer's problem.
    pub async fn send_chunk(&self, stream_id: &str, chunk: Bytes) -> bool {
        let map = self.inner.lock().await;
        let Some(entry) = map.get(stream_id).cloned() else {
            return false;
        };
        drop(map);
        if entry.sender.is_closed() {
            return false;
        }
        entry.sender.try_send(StreamChunk { bytes: chunk }).is_ok()
    }

    /// Drop the sender. Drains the receiver and the streaming body
    /// finishes cleanly. Safe to call multiple times.
    pub async fn close(&self, stream_id: &str) -> bool {
        let mut map = self.inner.lock().await;
        map.remove(stream_id).is_some()
    }

    /// Wait until the **receiver** half of `stream_id` is dropped — that
    /// is, until hyper has finished sending the body or the client has
    /// disconnected. Returns immediately if the id is unknown (so a JS
    /// caller that races a close + on_disconnect never deadlocks).
    pub async fn wait_for_disconnect(&self, stream_id: &str) {
        let entry = {
            let map = self.inner.lock().await;
            map.get(stream_id).cloned()
        };
        let Some(entry) = entry else { return };
        // `sender.closed()` resolves the moment the matched receiver is
        // dropped. Hyper drops the body on connection close, which
        // drops the receiver — so this future doubles as a client-
        // disconnect signal.
        entry.sender.closed().await;
    }

    /// Reap registered-but-never-served strays older than [`STRAY_TTL`] — the
    /// "5-min idle GC pass" from the module doc. A stray is an entry whose
    /// receiver was never taken (the handler panicked between `register` and
    /// returning the response), so it would otherwise leak. Returns how many
    /// were removed.
    pub async fn reap_strays(&self) -> usize {
        self.reap_older_than(STRAY_TTL).await
    }

    /// Reap never-served entries older than `ttl`. An ACTIVE served stream
    /// (its receiver already taken by the response builder) is exempt no matter
    /// its age, so a long-lived SSE connection is never killed. `ttl` is a
    /// parameter so callers/tests can pick the window; [`reap_strays`] uses
    /// [`STRAY_TTL`].
    pub async fn reap_older_than(&self, ttl: Duration) -> usize {
        let mut map = self.inner.lock().await;
        // `try_lock` on the receiver slot tells served-vs-stray without
        // awaiting under the map lock: a served stream's slot is `None`; a
        // stray's is still `Some`. A momentarily-locked slot (mid take) is
        // treated as in-use and left alone.
        let strays: Vec<StreamId> = map
            .iter()
            .filter(|(_, entry)| entry.created_at.elapsed() > ttl)
            .filter(|(_, entry)| {
                entry
                    .receiver
                    .try_lock()
                    .map(|slot| slot.is_some())
                    .unwrap_or(false)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &strays {
            map.remove(id);
        }
        strays.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_send_chunk_roundtrip() {
        let reg = StreamRegistry::new();
        assert!(reg.register("s1".to_string()).await);
        let mut rx = reg.take_receiver("s1").await.expect("receiver");

        assert!(reg.send_chunk("s1", Bytes::from_static(b"hello")).await);
        assert!(reg.send_chunk("s1", Bytes::from_static(b"world")).await);

        let first = rx.recv().await.unwrap();
        assert_eq!(first.bytes, Bytes::from_static(b"hello"));
        let second = rx.recv().await.unwrap();
        assert_eq!(second.bytes, Bytes::from_static(b"world"));
    }

    #[tokio::test]
    async fn duplicate_register_returns_false() {
        let reg = StreamRegistry::new();
        assert!(reg.register("s1".to_string()).await);
        assert!(!reg.register("s1".to_string()).await);
    }

    #[tokio::test]
    async fn close_drops_sender_and_send_returns_false() {
        let reg = StreamRegistry::new();
        assert!(reg.register("s1".to_string()).await);
        let _rx = reg.take_receiver("s1").await.expect("receiver");
        assert!(reg.close("s1").await);
        assert!(!reg.send_chunk("s1", Bytes::from_static(b"x")).await);
    }

    #[tokio::test]
    async fn wait_for_disconnect_fires_when_receiver_drops() {
        let reg = StreamRegistry::new();
        reg.register("s1".to_string()).await;
        let rx = reg.take_receiver("s1").await.unwrap();
        let reg_clone = reg.clone();
        let waiter = tokio::spawn(async move {
            reg_clone.wait_for_disconnect("s1").await;
            true
        });
        drop(rx);
        assert!(waiter.await.unwrap());
    }

    #[tokio::test]
    async fn reap_removes_never_served_strays_but_keeps_active_streams() {
        let reg = StreamRegistry::new();
        reg.register("stray".to_string()).await; // never served (receiver not taken)
        reg.register("served".to_string()).await;
        let _rx = reg.take_receiver("served").await.expect("receiver"); // active

        // ttl = ZERO ⇒ every entry is "older than ttl"; only the never-served
        // stray is reaped, the active stream survives regardless of age.
        let reaped = reg.reap_older_than(Duration::ZERO).await;
        assert_eq!(reaped, 1);

        assert!(
            !reg.send_chunk("stray", Bytes::from_static(b"x")).await,
            "stray must be gone"
        );
        assert!(
            reg.send_chunk("served", Bytes::from_static(b"x")).await,
            "active served stream must survive"
        );
    }
}

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
    sender: Mutex<Option<mpsc::Sender<StreamChunk>>>,
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
            sender: Mutex::new(Some(sender)),
            receiver: Mutex::new(Some(receiver)),
            created_at: Instant::now(),
        });
        map.insert(stream_id, entry);
        true
    }

    /// Pull the receiver out of the registry. Called once by the response
    /// builder when the streaming body is created. Subsequent calls
    /// return `None` (each receiver can only be consumed once).
    pub async fn take_receiver(&self, stream_id: &str) -> Option<mpsc::Receiver<StreamChunk>> {
        let map = self.inner.lock().await;
        let entry = map.get(stream_id)?.clone();
        drop(map);
        let mut rx_slot = entry.receiver.lock().await;
        let rx = rx_slot.take();
        drop(rx_slot);
        // A stream closed before anyone claimed its receiver was kept alive for
        // exactly this moment; now that the body owns it, the entry is spent.
        if rx.is_some() && entry.sender.lock().await.is_none() {
            self.inner.lock().await.remove(stream_id);
        }
        rx
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
        let sender = entry.sender.lock().await;
        let Some(sender) = sender.as_ref() else {
            return false;
        };
        if sender.is_closed() {
            return false;
        }
        sender.try_send(StreamChunk { bytes: chunk }).is_ok()
    }

    /// Push a chunk, WAITING for room when the channel is full.
    ///
    /// The counterpart of [`send_chunk`](Self::send_chunk) for bodies where a
    /// dropped frame is corruption rather than a skipped event: a file, an
    /// export, anything the client reassembles. Awaiting applies real
    /// back-pressure — a slow reader slows the producer instead of losing
    /// bytes. Returns `false` only when the receiver is gone (client left).
    pub async fn send_chunk_awaiting(&self, stream_id: &str, chunk: impl Into<Bytes>) -> bool {
        let map = self.inner.lock().await;
        let Some(entry) = map.get(stream_id).cloned() else {
            return false;
        };
        drop(map);
        // Cloned out of the guard: `send().await` parks until there is room,
        // and holding the entry lock across that would block every other
        // stream's writer on this one's slow client.
        let sender = { entry.sender.lock().await.clone() };
        let Some(sender) = sender else {
            return false;
        };
        sender
            .send(StreamChunk {
                bytes: chunk.into(),
            })
            .await
            .is_ok()
    }

    /// Finish a stream: drop its SENDER so the body sees EOF once the queued
    /// chunks are drained. Safe to call multiple times.
    ///
    /// The entry itself stays until the receiver has been taken. Removing it
    /// outright lost a receiver nobody had claimed yet, which is exactly what
    /// happens with a small body: the producer writes and closes before the
    /// response has even reached the hyper side, and the client then got
    /// `E_STREAM_UNKNOWN` instead of a short, complete body. A closed entry
    /// whose receiver was already taken is dropped here; one still waiting is
    /// left for [`take_receiver`](Self::take_receiver) to collect, and the
    /// stray GC reaps it if nobody ever does.
    pub async fn close(&self, stream_id: &str) -> bool {
        let map = self.inner.lock().await;
        let Some(entry) = map.get(stream_id).cloned() else {
            return false;
        };
        drop(map);

        let dropped = entry.sender.lock().await.take().is_some();
        // Nothing left to hand out AND nothing left to send: the entry is spent.
        let claimed = entry.receiver.lock().await.is_none();
        if claimed {
            self.inner.lock().await.remove(stream_id);
        }
        dropped
    }

    /// Drop every registered stream's sender at once. Each active SSE/streamed
    /// body sees EOF and finishes — called on server shutdown so the connection
    /// tasks holding those bodies can end (and release their handler clones).
    /// Returns how many entries were dropped.
    pub async fn drain(&self) -> usize {
        let mut map = self.inner.lock().await;
        let n = map.len();
        map.clear();
        n
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
        // Cloned out of the guard: this future lives as long as the
        // connection, and holding the entry lock for that would freeze the
        // stream. A sender already taken (the stream was closed) means there is
        // nothing left to watch.
        let sender = { entry.sender.lock().await.clone() };
        if let Some(sender) = sender {
            sender.closed().await;
        }
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
    async fn awaiting_send_carries_bytes_that_are_not_utf8() {
        // The whole reason this variant takes bytes: a PNG header, a zip, a
        // PDF — none of it survives a String round-trip.
        let reg = StreamRegistry::new();
        reg.register("bin".to_string()).await;
        let mut rx = reg.take_receiver("bin").await.expect("receiver");

        let payload: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0xFE, 0x80];
        assert!(reg.send_chunk_awaiting("bin", payload.clone()).await);

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.bytes.as_ref(), payload.as_slice());
    }

    #[tokio::test]
    async fn awaiting_send_blocks_instead_of_dropping_when_full() {
        // The difference that matters for a file: `send_chunk` drops a frame
        // when the buffer is full (fine for SSE, silent corruption for a
        // download); this one waits for room.
        let reg = StreamRegistry::new();
        reg.register("slow".to_string()).await;
        let mut rx = reg.take_receiver("slow").await.expect("receiver");

        // Fill the channel to capacity.
        for i in 0..STREAM_BUFFER_FRAMES {
            assert!(
                reg.send_chunk_awaiting("slow", vec![i as u8]).await,
                "frame {i} should be accepted"
            );
        }

        // One more would block, so park it and prove it has NOT resolved.
        let reg2 = reg.clone();
        let pending =
            tokio::spawn(async move { reg2.send_chunk_awaiting("slow", vec![255]).await });
        tokio::task::yield_now().await;
        assert!(!pending.is_finished(), "the extra frame must wait for room");

        // Draining one frame makes room, and the parked send completes.
        let first = rx.recv().await.unwrap();
        assert_eq!(first.bytes.as_ref(), &[0u8]);
        assert!(pending.await.unwrap(), "the waited frame is delivered");
    }

    #[tokio::test]
    async fn awaiting_send_reports_a_gone_client_instead_of_hanging() {
        // If the receiver is dropped mid-wait the producer must be told, not
        // left parked forever on a connection nobody is reading.
        let reg = StreamRegistry::new();
        reg.register("gone".to_string()).await;
        let rx = reg.take_receiver("gone").await.expect("receiver");
        drop(rx);

        assert!(!reg.send_chunk_awaiting("gone", vec![1, 2, 3]).await);
    }

    #[tokio::test]
    async fn awaiting_send_on_an_unknown_stream_is_false() {
        let reg = StreamRegistry::new();
        assert!(!reg.send_chunk_awaiting("nope", vec![1]).await);
    }

    #[tokio::test]
    async fn awaiting_send_preserves_order() {
        let reg = StreamRegistry::new();
        reg.register("ord".to_string()).await;
        let mut rx = reg.take_receiver("ord").await.expect("receiver");

        for i in 0..16u8 {
            reg.send_chunk_awaiting("ord", vec![i]).await;
        }
        for i in 0..16u8 {
            assert_eq!(rx.recv().await.unwrap().bytes.as_ref(), &[i]);
        }
    }

    #[tokio::test]
    async fn a_stream_closed_before_anyone_claimed_it_still_delivers() {
        // The race a small body hits every time: the producer writes and closes
        // before the response has reached the hyper side, so `take_receiver`
        // runs AFTER `close`. Removing the entry there lost the body and the
        // client saw `E_STREAM_UNKNOWN` instead of a short, complete download.
        let reg = StreamRegistry::new();
        reg.register("fast".to_string()).await;

        assert!(reg.send_chunk_awaiting("fast", vec![1, 2, 3]).await);
        assert!(reg.close("fast").await);

        // Claimed only now — and the queued chunk must still be there.
        let mut rx = reg
            .take_receiver("fast")
            .await
            .expect("a closed stream keeps its receiver until someone takes it");
        assert_eq!(rx.recv().await.unwrap().bytes.as_ref(), &[1u8, 2, 3]);
        // Sender dropped, so the body sees EOF right after.
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn closing_after_the_receiver_was_taken_frees_the_entry() {
        // The ordinary order: hyper claimed the body, then the producer
        // finished. Nothing is left to hand out, so the entry must not linger.
        let reg = StreamRegistry::new();
        reg.register("normal".to_string()).await;
        let mut rx = reg.take_receiver("normal").await.expect("receiver");

        assert!(reg.send_chunk_awaiting("normal", vec![9]).await);
        assert!(reg.close("normal").await);

        assert_eq!(rx.recv().await.unwrap().bytes.as_ref(), &[9u8]);
        assert!(rx.recv().await.is_none());
        // Gone from the map: a second close finds nothing.
        assert!(!reg.close("normal").await);
    }

    #[tokio::test]
    async fn writing_to_a_closed_stream_reports_false() {
        let reg = StreamRegistry::new();
        reg.register("shut".to_string()).await;
        reg.close("shut").await;

        // The sender is gone, so the producer is told to stop rather than
        // queueing into a stream that will never be read.
        assert!(!reg.send_chunk_awaiting("shut", vec![1]).await);
        assert!(!reg.send_chunk("shut", Bytes::from_static(b"x")).await);
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
    async fn drain_drops_all_senders() {
        let reg = StreamRegistry::new();
        reg.register("a".to_string()).await;
        reg.register("b".to_string()).await;
        let _rx_a = reg.take_receiver("a").await.expect("receiver");

        assert_eq!(reg.drain().await, 2);

        // Both gone — pushes fail, nothing left to serve.
        assert!(!reg.send_chunk("a", Bytes::from_static(b"x")).await);
        assert!(!reg.send_chunk("b", Bytes::from_static(b"x")).await);
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

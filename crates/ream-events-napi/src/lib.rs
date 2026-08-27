//! # ream-bus-napi
//!
//! NAPI bindings for the event bus.
//! Uses shared Tokio runtime — no block_on (PERF-2, PERF-3).
//!
//! @implements FR1, FR2, FR3, FR9

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction};
use napi_derive::napi;
use ream_events::{Bus, Event};
use ream_napi_core::catch_unwind_napi;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration as StdDuration;

const DEFAULT_REQUEST_HANDLER_TIMEOUT_MS: u64 = 5_000;

/// NAPI-exposed event bus.
/// Uses shared Tokio runtime (no per-instance runtime).
#[napi]
pub struct EventBus {
    bus: Arc<Bus>,
    request_handler_timeout_ms: u64,
}

/// Shared state for passing reply channels from Rust to JS.
struct RequestContext {
    event_json: String,
    reply_tx: Arc<Mutex<Option<mpsc::SyncSender<String>>>>,
}

#[napi]
impl EventBus {
    #[napi(constructor)]
    pub fn new(request_handler_timeout_ms: Option<f64>) -> napi::Result<Self> {
        catch_unwind_napi(|| {
            Ok(Self {
                bus: Arc::new(Bus::new()),
                request_handler_timeout_ms: request_handler_timeout_ms
                    .map(|ms| ms as u64)
                    .unwrap_or(DEFAULT_REQUEST_HANDLER_TIMEOUT_MS),
            })
        })
    }

    /// Emit an event (async — does NOT block Node.js thread).
    #[napi]
    pub async fn emit(&self, name: String, data: String) -> napi::Result<String> {
        let bus = self.bus.clone();
        let rt = ream_napi_core::shared_runtime();
        let event = rt.spawn(async move {
            bus.emit(&name, &data).await
        }).await.map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))?;

        serde_json::to_string(&event)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))
    }

    /// Subscribe to events matching a pattern. Callback receives event JSON string.
    /// Returns subscription ID.
    ///
    /// NOTE: This is `pub fn` (sync) — napi-rs cannot make `async fn` capture
    /// `JsFunction` because JsFunction isn't Send. The block_on here runs on the
    /// JS thread (no async context above), so it doesn't deadlock the runtime.
    #[napi]
    pub fn subscribe(&self, pattern: String, callback: JsFunction) -> napi::Result<f64> {
        let tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<String>| {
                Ok(vec![ctx.env.create_string_from_std(ctx.value)?.into_unknown()])
            })?;

        let tsfn = Arc::new(tsfn);
        let bus = self.bus.clone();
        let rt = ream_napi_core::shared_runtime();

        let sub_id = rt.block_on(async move {
            bus.subscribe(&pattern, Arc::new(move |event: Event| {
                let json = serde_json::to_string(&event).unwrap_or_default();
                let _ = tsfn.call(json, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
            })).await
        });

        Ok(sub_id as f64)
    }

    /// Unsubscribe by subscription ID.
    #[napi]
    pub async fn unsubscribe(&self, sub_id: f64) -> napi::Result<()> {
        let bus = self.bus.clone();
        let id = sub_id as u64;
        let rt = ream_napi_core::shared_runtime();
        rt.spawn(async move {
            bus.unsubscribe(id).await;
        }).await.map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))?;
        Ok(())
    }

    /// Register a request handler.
    #[napi]
    pub fn on_request(&self, name: String, callback: JsFunction) -> napi::Result<()> {
        let tsfn: ThreadsafeFunction<RequestContext, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<RequestContext>| {
                let event_str = ctx.env.create_string_from_std(ctx.value.event_json)?;
                let reply_tx = ctx.value.reply_tx;

                let reply_fn = ctx.env.create_function_from_closure("reply", move |ctx| {
                    let response: String = ctx.get::<napi::JsString>(0)?.into_utf8()?.as_str()?.to_string();
                    if let Ok(mut guard) = reply_tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(response);
                        }
                    }
                    ctx.env.get_undefined()
                })?;

                Ok(vec![event_str.into_unknown(), reply_fn.into_unknown()])
            })?;

        let tsfn = Arc::new(tsfn);
        let bus = self.bus.clone();
        let timeout_ms = self.request_handler_timeout_ms;

        // Registered inline, NOT spawned onto the runtime. Spawning made this
        // return before the handler existed, so `onRequest(name, ...)` followed
        // by `request(name, ...)` raced the scheduler — it passed in isolation
        // and failed under load with "No request handler for '<name>'".
        bus.on_request(
            &name,
            Arc::new(move |event| {
                let json = serde_json::to_string(&event).unwrap_or_default();
                let (tx, rx) = mpsc::sync_channel::<String>(1);

                let ctx = RequestContext {
                    event_json: json,
                    reply_tx: Arc::new(Mutex::new(Some(tx))),
                };

                let _ = tsfn.call(ctx, napi::threadsafe_function::ThreadsafeFunctionCallMode::Blocking);

                match rx.recv_timeout(StdDuration::from_millis(timeout_ms)) {
                    Ok(response) => response,
                    Err(_) => panic!("request handler timeout after {}ms", timeout_ms),
                }
            }),
        );

        Ok(())
    }

    /// Send a request and get a response (async with timeout).
    #[napi]
    pub async fn request(&self, name: String, data: String, timeout_ms: Option<f64>) -> napi::Result<String> {
        let bus = self.bus.clone();
        let timeout = timeout_ms.unwrap_or(5000.0) as u64;
        let rt = ream_napi_core::shared_runtime();

        let result = rt.spawn(async move {
            bus.request(&name, &data, timeout).await
        }).await.map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))?;

        result.map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    }

    /// Check if a pattern matches an event name (wildcard matching via Rust).
    #[napi]
    pub fn matches_wildcard(&self, pattern: String, event_name: String) -> napi::Result<bool> {
        Ok(ream_events::wildcard_matches(&pattern, &event_name))
    }

    /// Get subscription count.
    #[napi]
    pub async fn subscription_count(&self) -> napi::Result<f64> {
        let bus = self.bus.clone();
        let rt = ream_napi_core::shared_runtime();
        let count = rt.spawn(async move {
            bus.subscription_count().await
        }).await.map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))?;
        Ok(count as f64)
    }
}

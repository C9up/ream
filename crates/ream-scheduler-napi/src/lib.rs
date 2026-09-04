//! # ream-scheduler-napi
//!
//! NAPI bindings for the Ream scheduler. Exposes [`RustScheduler`] as a
//! `#[napi]` class that TS code instantiates, registers tasks against,
//! starts, and stops. The ticker runs entirely in Rust on the shared
//! Tokio runtime (`ream_napi_core::shared_runtime`).
//!
//! @implements Story 28.1

use napi::bindgen_prelude::*;
use napi::bindgen_prelude::{Function, Unknown};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;
use ream_napi_core::callback::CallbackConfig;

/// A task callback that does NOT hold Node's event loop open.
///
/// A `ThreadsafeFunction` keeps the loop referenced for as long as it lives, and
/// one is created per registered task. `stop()` cancels the tick loop but the
/// callbacks live on in the task registry, so a process that had merely
/// REGISTERED a task never exited: every console command booting an app with a
/// `@Schedule` in it ran to completion and then hung until the operator or a
/// timeout killed it. Nothing in JS showed why —
/// `process.getActiveResourcesInfo()` reported an empty list, because the
/// reference is held below it.
///
/// Weak is the honest shape: a scheduler is a side concern, not a reason for a
/// process to exist. A server is held open by its listener; a long-running
/// scheduler process is held open by the command that runs it, the way
/// `queue:work` holds its own.
type WeakTaskCallback<T> = napi::threadsafe_function::ThreadsafeFunction<
    T,
    Unknown<'static>,
    Unknown<'static>,
    napi::Status,
    false,
    true,
    0,
>;
use ream_napi_core::{catch_unwind_napi, shared_runtime, ReamError};
use ream_scheduler::{RustScheduler as CoreScheduler, TaskInvoker, TaskPayload};
use serde::Serialize;
use std::sync::Arc;

/// JSON-serializable payload delivered to the JS callback.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JsTaskPayload {
    task_name: String,
    scheduled_for_ms: i64,
}

impl From<TaskPayload> for JsTaskPayload {
    fn from(p: TaskPayload) -> Self {
        Self {
            task_name: p.task_name,
            scheduled_for_ms: p.scheduled_for_ms,
        }
    }
}

/// Bridges a registered task invocation to a JS `ThreadsafeFunction`.
/// Non-blocking call — the ticker thread does not wait on the JS event loop.
struct JsTaskInvoker {
    tsfn: WeakTaskCallback<JsTaskPayload>,
}

impl TaskInvoker for JsTaskInvoker {
    fn invoke(&self, payload: TaskPayload) {
        let js_payload: JsTaskPayload = payload.into();
        // NonBlocking: returns immediately; JS runs on the main thread.
        //
        // Return status is intentionally discarded. `Status::Closing`
        // (Node shutting down) and `Status::QueueFull` (backpressure)
        // are possible here; in both cases the invocation is dropped
        // silently. Story 28.4 will wire a richer observability surface
        // (`ObservabilityHook::on_invocation_dropped`) so these drops
        // become visible to the event bus; until then, callers should treat
        // occasional drop as best-effort delivery under extreme load
        // or during shutdown.
        //
        // Audit 2026-05-22: `ErrorStrategy::Fatal` (no err arg) is what
        // the TS `Scheduler.register` wrapper expects — see the helper
        // comment in `ream-napi-core::callback::create_threadsafe_fn`
        // for the bug history.
        let _ = self
            .tsfn
            .call(js_payload, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Scheduler instance exposed to TypeScript.
///
/// Usage (from TS):
/// ```ignore
/// const scheduler = new RustScheduler();
/// scheduler.register('cleanup', '0 */5 * * *', (payload) => { ... });
/// scheduler.start();
/// // later
/// scheduler.stop();
/// ```
#[napi]
pub struct RustScheduler {
    inner: Arc<CoreScheduler>,
}

#[napi]
impl RustScheduler {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CoreScheduler::new()),
        }
    }

    /// Register a task. `cronExpr` is a standard 5-field cron expression
    /// evaluated in UTC.
    ///
    /// Throws with `DUPLICATE_TASK` if `name` already exists, or
    /// `INVALID_CRON` if the expression is malformed.
    #[napi]
    pub fn register(
        &self,
        name: String,
        cron_expr: String,
        callback: Function<'static, Unknown<'static>, Unknown<'static>>,
    ) -> Result<()> {
        // Routed through `ream_napi_core::callback::create_threadsafe_fn`
        // so all Ream NAPI crates share identical ThreadsafeFunction
        // setup (see ream-http-napi, ream-events-napi). Matches the
        // `CallbackConfig::default()` convention: unlimited queue,
        // non-blocking calls.
        // Built here rather than through `create_threadsafe_fn`: the shared
        // helper returns a STRONG handle, which is right for the HTTP listener
        // and the event bus — both of which are a reason for the process to be
        // running — and wrong for this one.
        let config = CallbackConfig::default();
        if config.max_queue_size != 0 {
            return Err(napi::Error::new(
                napi::Status::InvalidArg,
                "max_queue_size is a compile-time constant in napi 3; only 0 (unlimited) is supported",
            ));
        }
        let tsfn: WeakTaskCallback<JsTaskPayload> = callback
            .build_threadsafe_function::<JsTaskPayload>()
            .callee_handled::<false>()
            .weak::<true>()
            .build_callback(
                |ctx: napi::threadsafe_function::ThreadsafeCallContext<JsTaskPayload>| {
                    ctx.env.to_js_value(&ctx.value)
                },
            )?;

        let inner = Arc::clone(&self.inner);
        catch_unwind_napi(std::panic::AssertUnwindSafe(move || {
            let invoker: Arc<dyn TaskInvoker> = Arc::new(JsTaskInvoker { tsfn });
            inner
                .register(name, &cron_expr, invoker)
                .map_err(ream_err_to_napi)?;
            Ok(())
        }))
    }

    /// Remove a task. Idempotent — unknown names are not an error.
    #[napi]
    pub fn unregister(&self, name: String) -> Result<()> {
        let inner = Arc::clone(&self.inner);
        catch_unwind_napi(std::panic::AssertUnwindSafe(move || {
            inner.unregister(&name).map_err(ream_err_to_napi)?;
            Ok(())
        }))
    }

    /// Launch the tick loop on the shared Tokio runtime. Idempotent.
    #[napi]
    pub fn start(&self) -> Result<()> {
        let inner = Arc::clone(&self.inner);
        catch_unwind_napi(std::panic::AssertUnwindSafe(move || {
            inner.start(shared_runtime()).map_err(ream_err_to_napi)?;
            Ok(())
        }))
    }

    /// Cancel the tick loop. Safe to call even if not running.
    #[napi]
    pub fn stop(&self) -> Result<()> {
        let inner = Arc::clone(&self.inner);
        catch_unwind_napi(std::panic::AssertUnwindSafe(move || {
            inner.stop().map_err(ream_err_to_napi)?;
            Ok(())
        }))
    }

    /// Return the next fire time in ms epoch, or `null` if the task is unknown.
    #[napi]
    pub fn next_run(&self, name: String) -> Result<Option<i64>> {
        let inner = Arc::clone(&self.inner);
        catch_unwind_napi(std::panic::AssertUnwindSafe(move || {
            inner.next_run(&name).map_err(ream_err_to_napi)
        }))
    }
}

fn ream_err_to_napi(err: ReamError) -> napi::Error {
    err.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify `ReamError`-to-`napi::Error` surface: the reason string
    /// must carry the JSON payload that the TS `ReamError` class parses
    /// (code + message at minimum).
    #[test]
    fn ream_error_surfaces_as_napi_error_with_json_reason() {
        let err = ReamError::new("SCHED_TEST", "test failure")
            .with_hint("test hint")
            .with_context("task", "demo");
        let napi_err: napi::Error = ream_err_to_napi(err);
        let reason = napi_err.reason;
        assert!(reason.contains("SCHED_TEST"), "code missing: {}", reason);
        assert!(
            reason.contains("test failure"),
            "message missing: {}",
            reason
        );
        assert!(reason.contains("test hint"), "hint missing: {}", reason);
        assert!(reason.contains("demo"), "context missing: {}", reason);
    }

    /// Verify `JsTaskPayload` serializes with camelCase field names so
    /// the JS callback receives `{ taskName, scheduledForMs }`.
    #[test]
    fn js_task_payload_serializes_camel_case() {
        let payload = JsTaskPayload {
            task_name: "my-job".to_string(),
            scheduled_for_ms: 1_700_000_000_000,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"taskName\":\"my-job\""), "json: {}", json);
        assert!(
            json.contains("\"scheduledForMs\":1700000000000"),
            "json: {}",
            json
        );
        // Snake-case fields must NOT appear.
        assert!(!json.contains("task_name"), "snake_case leaked: {}", json);
        assert!(
            !json.contains("scheduled_for_ms"),
            "snake_case leaked: {}",
            json
        );
    }

    /// `TaskPayload` → `JsTaskPayload` round-trip preserves values.
    #[test]
    fn task_payload_conversion_is_lossless() {
        let core_payload = TaskPayload {
            task_name: "roundtrip".to_string(),
            scheduled_for_ms: 42,
        };
        let js_payload: JsTaskPayload = core_payload.into();
        assert_eq!(js_payload.task_name, "roundtrip");
        assert_eq!(js_payload.scheduled_for_ms, 42);
    }
}

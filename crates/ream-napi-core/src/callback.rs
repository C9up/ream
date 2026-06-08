//! ThreadsafeFunction helpers for Rust→JS callbacks.
//!
//! Provides typed wrappers around napi-rs `ThreadsafeFunction` to simplify
//! calling JavaScript from Rust threads (used by Hyper onRequest and event-bus dispatch).
//!
//! @implements AR2

use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction, JsUnknown};

/// Configuration for ThreadsafeFunction creation.
#[derive(Default)]
pub struct CallbackConfig {
    /// Maximum queue size (0 = unlimited)
    pub max_queue_size: usize,
    /// Whether to use blocking call mode
    pub blocking: bool,
}

// Default derived: max_queue_size = 0, blocking = false

/// Create a ThreadsafeFunction from a JS function reference.
///
/// This is the standard way to capture a JS callback in Rust
/// so it can be called from any thread (tokio, Hyper, etc.).
///
/// # Arguments
///
/// * `js_fn` - The JavaScript function to wrap
/// * `config` - Configuration for the ThreadsafeFunction
///
/// # Example
///
/// ```ignore
/// // In a #[napi] function:
/// use ream_napi_core::callback::{create_threadsafe_fn, CallbackConfig};
///
/// #[napi]
/// fn register_callback(callback: JsFunction) -> napi::Result<()> {
///     let tsfn = create_threadsafe_fn::<String>(&callback, CallbackConfig::default())?;
///     // tsfn can now be called from any thread
///     Ok(())
/// }
/// ```
pub fn create_threadsafe_fn<T>(
    js_fn: &JsFunction,
    config: CallbackConfig,
) -> napi::Result<ThreadsafeFunction<T, ErrorStrategy::Fatal>>
where
    T: 'static + Send + serde::Serialize,
{
    // Audit 2026-05-22: switched from `ErrorStrategy::CalleeHandled` to
    // `ErrorStrategy::Fatal`. The Ream NAPI surface never sends `Err` via
    // these threadsafe functions — every call site wraps its payload in
    // `Ok(...)`. With CalleeHandled the JS callback is invoked as
    // `function(err, ...args)` — `err === null` for our (always-Ok)
    // invocations — so the JS side has to know to skip the first arg.
    // The TS `Scheduler.register` wrapper took the payload as its first
    // parameter and silently received `null` instead, producing
    // `Cannot read properties of null (reading 'scheduledForMs')` the
    // moment the Rust ticker fired (5 of 6 NAPI integration tests
    // exercise register/unregister/listTasks paths that never invoke
    // the callback, so this latent bug was only visible under the slow
    // `REAM_RUN_SLOW_TESTS=1` ticker test). Switching to `Fatal` makes
    // JS receive only the payload, matching the TS signature naturally.
    // HTTP-NAPI uses `ErrorStrategy::Fatal` directly (not via this
    // helper), so no cross-crate surface changes.
    js_fn
        .create_threadsafe_function(config.max_queue_size, |ctx: ThreadSafeCallContext<T>| {
            let value = ctx.env.to_js_value(&ctx.value)?;
            Ok(vec![value])
        })
}

/// Call a ThreadsafeFunction with the given data, non-blocking.
///
/// Returns immediately. The JS callback will be invoked on the Node.js event loop.
pub fn call_threadsafe_fn<T: 'static + Send + serde::Serialize>(
    tsfn: &ThreadsafeFunction<T, ErrorStrategy::Fatal>,
    data: T,
) -> napi::Result<()> {
    let status = tsfn.call(data, ThreadsafeFunctionCallMode::NonBlocking);
    if status == napi::Status::Ok {
        Ok(())
    } else {
        Err(napi::Error::new(status, "ThreadsafeFunction call failed"))
    }
}

/// Call a ThreadsafeFunction with the given data, blocking until the JS event loop picks it up.
///
/// Use sparingly — this blocks the calling Rust thread.
pub fn call_threadsafe_fn_blocking<T: 'static + Send + serde::Serialize>(
    tsfn: &ThreadsafeFunction<T, ErrorStrategy::Fatal>,
    data: T,
) -> napi::Result<()> {
    let status = tsfn.call(data, ThreadsafeFunctionCallMode::Blocking);
    if status == napi::Status::Ok {
        Ok(())
    } else {
        Err(napi::Error::new(status, "ThreadsafeFunction blocking call failed"))
    }
}

/// Convert a `JsUnknown` value from a JS callback return into a typed Rust value.
///
/// Used to extract the response from a JS callback back into Rust
/// (e.g., the HTTP response from a Hyper onRequest handler).
pub fn extract_callback_result<T>(env: &Env, value: JsUnknown) -> napi::Result<T>
where
    T: serde::de::DeserializeOwned,
{
    env.from_js_value(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_callback_config_default() {
        let config = CallbackConfig::default();
        assert_eq!(config.max_queue_size, 0);
        assert!(!config.blocking);
    }

    #[test]
    fn test_callback_config_custom() {
        let config = CallbackConfig {
            max_queue_size: 100,
            blocking: true,
        };
        assert_eq!(config.max_queue_size, 100);
        assert!(config.blocking);
    }

    // Note: ThreadsafeFunction creation and calling requires a Node.js runtime.
    // Integration tests for actual callback invocation are in Stories 2.1 (Hyper) and 3.1 (event bus).
}

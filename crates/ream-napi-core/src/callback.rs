//! ThreadsafeFunction helpers for Rust→JS callbacks.
//!
//! Provides typed wrappers around napi-rs `ThreadsafeFunction` to simplify
//! calling JavaScript from Rust threads (used by Hyper onRequest and event-bus dispatch).
//!
//! @implements AR2

use napi::bindgen_prelude::{Function, Unknown};
use napi::threadsafe_function::{
    ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, Status};

/// The threadsafe function this crate hands out.
///
/// `CalleeHandled = false` is napi 3's spelling of napi 2's
/// `ErrorStrategy::Fatal`, and it is NOT napi 3's default — the default is
/// `true`, which PREPENDS a `null` so JavaScript is called as
/// `(err, payload)`. Every TypeScript wrapper on this surface takes the
/// payload FIRST, so accepting the default hands them `null` and reproduces
/// the failure recorded below exactly. It is spelled once, here, rather than
/// at each call site, because the wrong value compiles and passes every test
/// that does not actually invoke the callback.
///
/// `Args` is what the callback hands to JavaScript, which is not the same as
/// `T`: a callback that converts its payload with `to_js_value` produces one
/// JS value, one with nothing to pass produces `()`, and one that also passes
/// a `reply` function produces a pair. `Return` is what JavaScript hands
/// back — napi 3 carries it on the type where napi 2 named it at the
/// `call_async` call site.
pub type FatalThreadsafeFunction<T, Args = Unknown<'static>, Return = Unknown<'static>> =
    ThreadsafeFunction<T, Return, Args, Status, false, false, 0>;

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
    js_fn: &Function<'static, Unknown<'static>, Unknown<'static>>,
    config: CallbackConfig,
) -> napi::Result<FatalThreadsafeFunction<T>>
where
    T: 'static + Send + serde::Serialize,
{
    // napi 3 made the queue size a CONST generic, so a bound chosen at runtime
    // can no longer be honoured. The one caller asks for the default, and 0
    // means unlimited — but a caller asking for a bound must be told it cannot
    // have one rather than silently getting none.
    if config.max_queue_size != 0 {
        return Err(napi::Error::new(
            Status::InvalidArg,
            "max_queue_size is a compile-time constant in napi 3; only 0 (unlimited) is supported",
        ));
    }
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
        .build_threadsafe_function::<T>()
        .callee_handled::<false>()
        .build_callback(|ctx: ThreadsafeCallContext<T>| ctx.env.to_js_value(&ctx.value))
}

/// Call a ThreadsafeFunction with the given data, non-blocking.
///
/// Returns immediately. The JS callback will be invoked on the Node.js event loop.
pub fn call_threadsafe_fn<T: 'static + Send + serde::Serialize>(
    tsfn: &FatalThreadsafeFunction<T>,
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
    tsfn: &FatalThreadsafeFunction<T>,
    data: T,
) -> napi::Result<()> {
    let status = tsfn.call(data, ThreadsafeFunctionCallMode::Blocking);
    if status == napi::Status::Ok {
        Ok(())
    } else {
        Err(napi::Error::new(
            status,
            "ThreadsafeFunction blocking call failed",
        ))
    }
}

/// Convert a `JsUnknown` value from a JS callback return into a typed Rust value.
///
/// Used to extract the response from a JS callback back into Rust
/// (e.g., the HTTP response from a Hyper onRequest handler).
pub fn extract_callback_result<T>(env: &Env, value: Unknown<'_>) -> napi::Result<T>
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

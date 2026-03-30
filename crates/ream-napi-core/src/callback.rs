//! ThreadsafeFunction helpers for Rust→JS callbacks.
//!
//! Provides typed wrappers around napi-rs `ThreadsafeFunction` to simplify
//! calling JavaScript from Rust threads (used by Hyper onRequest and Pulsar event dispatch).
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
) -> napi::Result<ThreadsafeFunction<T, ErrorStrategy::CalleeHandled>>
where
    T: 'static + Send + serde::Serialize,
{
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
    tsfn: &ThreadsafeFunction<T, ErrorStrategy::CalleeHandled>,
    data: T,
) -> napi::Result<()> {
    let status = tsfn.call(Ok(data), ThreadsafeFunctionCallMode::NonBlocking);
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
    tsfn: &ThreadsafeFunction<T, ErrorStrategy::CalleeHandled>,
    data: T,
) -> napi::Result<()> {
    let status = tsfn.call(Ok(data), ThreadsafeFunctionCallMode::Blocking);
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
    // Integration tests for actual callback invocation are in Stories 2.1 (Hyper) and 3.1 (Pulsar).
}

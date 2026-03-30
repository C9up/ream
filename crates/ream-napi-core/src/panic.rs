//! Panic catching utilities for NAPI entry points.
//!
//! Every NAPI-exported function must wrap its body in `catch_unwind_napi`
//! to prevent Rust panics from crashing the Node.js process.
//!
//! @implements AR2, NFR29

use crate::ReamError;
use std::panic;

/// Wraps a closure in `std::panic::catch_unwind`, converting panics
/// to `napi::Result<T>` via `ReamError`.
///
/// This is the primary safety mechanism for the Rust→NAPI boundary.
/// A Rust panic must NEVER crash the Node.js process.
///
/// # Example
///
/// ```
/// use ream_napi_core::catch_unwind_napi;
///
/// let result = catch_unwind_napi(|| Ok(42));
/// assert_eq!(result.unwrap(), 42);
///
/// let result: napi::Result<i32> = catch_unwind_napi(|| panic!("boom"));
/// assert!(result.is_err());
/// ```
pub fn catch_unwind_napi<F, T>(f: F) -> napi::Result<T>
where
    F: FnOnce() -> napi::Result<T> + panic::UnwindSafe,
{
    match panic::catch_unwind(f) {
        Ok(result) => result,
        Err(panic_payload) => {
            let message = extract_panic_message(&panic_payload);
            let err = ReamError::new("RUST_PANIC", format!("Rust panic caught: {}", message))
                .with_hint(
                    "This is a bug in the Ream framework. Please report it at https://github.com/c9up/ream/issues",
                );
            Err(err.into())
        }
    }
}

/// Wraps an infallible closure in panic protection.
///
/// Use this for closures that return `T` directly (not `napi::Result<T>`).
/// For closures returning `napi::Result<T>`, use [`catch_unwind_napi`] instead.
///
/// Note: `catch_unwind` does not catch panics across await points.
/// For async operations, use `tokio::task::spawn` with its own panic handling.
pub fn catch_unwind_napi_infallible<F, T>(f: F) -> napi::Result<T>
where
    F: FnOnce() -> T + panic::UnwindSafe,
{
    match panic::catch_unwind(f) {
        Ok(value) => Ok(value),
        Err(panic_payload) => {
            let message = extract_panic_message(&panic_payload);
            let err = ReamError::new("RUST_PANIC", format!("Rust panic caught: {}", message))
                .with_hint(
                    "This is a bug in the Ream framework. Please report it at https://github.com/c9up/ream/issues",
                );
            Err(err.into())
        }
    }
}

/// Extract a human-readable message from a panic payload.
fn extract_panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_catch_unwind_normal_execution() {
        let result = catch_unwind_napi(|| Ok(42));
        assert_eq!(result.unwrap(), 42);
    }

    #[test]
    fn test_catch_unwind_napi_error_passthrough() {
        let result: napi::Result<i32> = catch_unwind_napi(|| {
            Err(napi::Error::new(napi::Status::GenericFailure, "normal error"))
        });
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.reason, "normal error");
    }

    #[test]
    fn test_catch_unwind_string_panic() {
        let result: napi::Result<i32> = catch_unwind_napi(|| panic!("boom"));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.reason.contains("RUST_PANIC"));
        assert!(err.reason.contains("boom"));
    }

    #[test]
    fn test_catch_unwind_static_str_panic() {
        let result: napi::Result<i32> =
            catch_unwind_napi(|| panic!("static str panic"));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.reason.contains("static str panic"));
    }

    #[test]
    fn test_catch_unwind_sync_normal() {
        let result = catch_unwind_napi_infallible(|| 42);
        assert_eq!(result.unwrap(), 42);
    }

    #[test]
    fn test_catch_unwind_sync_panic() {
        let result: napi::Result<i32> =
            catch_unwind_napi_infallible(|| panic!("sync panic"));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.reason.contains("sync panic"));
    }

    #[test]
    fn test_extract_panic_message_string() {
        let msg = extract_panic_message(&(Box::new(String::from("hello")) as Box<dyn std::any::Any + Send>));
        assert_eq!(msg, "hello");
    }

    #[test]
    fn test_extract_panic_message_str() {
        let msg = extract_panic_message(&(Box::new("world") as Box<dyn std::any::Any + Send>));
        assert_eq!(msg, "world");
    }

    #[test]
    fn test_extract_panic_message_unknown() {
        let msg = extract_panic_message(&(Box::new(42i32) as Box<dyn std::any::Any + Send>));
        assert_eq!(msg, "unknown panic payload");
    }
}

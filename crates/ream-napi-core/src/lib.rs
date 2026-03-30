//! # ream-napi-core
//!
//! Shared NAPI utilities for the Ream framework.
//!
//! This crate provides the foundational types and utilities used across all
//! Ream NAPI bindings (`ream-bus-napi`, `ream-http-napi`, etc.):
//!
//! - [`ReamError`] — Structured error type for Rust→NAPI→TS error wrapping.
//!   Serializes to JSON so the TypeScript `ReamError` class can reconstruct
//!   rich errors with code, context, hint, and docs URL.
//!
//! - [`catch_unwind_napi`] — Wraps NAPI entry points in `std::panic::catch_unwind`.
//!   A Rust panic must NEVER crash the Node.js process (NFR29).
//!
//! - [`callback`] — ThreadsafeFunction helpers for Rust→JS callbacks
//!   (used by Hyper onRequest and Pulsar event dispatch).
//!
//! ## Usage Pattern
//!
//! Every NAPI-exported function in Ream crates should follow this pattern:
//!
//! ```rust,ignore
//! use ream_napi_core::{catch_unwind_napi, ReamError, ream_error};
//!
//! #[napi]
//! pub fn my_function(input: String) -> napi::Result<String> {
//!     catch_unwind_napi(|| {
//!         if input.is_empty() {
//!             return Err(ream_error!("INVALID_INPUT", "Input must not be empty")
//!                 .with_hint("Provide a non-empty string")
//!                 .into());
//!         }
//!         Ok(input.to_uppercase())
//!     })
//! }
//! ```
//!
//! @implements AR2

pub mod callback;
pub mod error;
pub mod panic;

// Re-export primary types at crate root for ergonomic imports
pub use error::ReamError;
pub use panic::{catch_unwind_napi, catch_unwind_napi_infallible};

/// Returns the crate version.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(version(), "0.1.0");
    }

    #[test]
    fn test_public_api_reexports() {
        // Verify the re-exports work
        let err = ReamError::new("TEST", "test");
        assert_eq!(err.code, "TEST");

        let result = catch_unwind_napi(|| Ok(42));
        assert_eq!(result.unwrap(), 42);
    }

    #[test]
    fn test_ream_error_macro_from_root() {
        let err = ream_error!("ROOT_TEST", "from root");
        assert_eq!(err.code, "ROOT_TEST");
        assert!(err.source_file.is_some());
    }
}

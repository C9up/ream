//! NAPI roundtrip test crate for Ream.
//!
//! This crate validates the Rust→NAPI→TypeScript→NAPI→Rust roundtrip
//! by exposing simple test functions via `#[napi]`.

use napi_derive::napi;
use ream_napi_core::{catch_unwind_napi, ream_error};

/// Basic string roundtrip — validates data crossing NAPI boundary.
#[napi]
pub fn hello(name: String) -> napi::Result<String> {
    catch_unwind_napi(|| Ok(format!("Hello, {}!", name)))
}

/// Numeric roundtrip — validates primitive types crossing NAPI.
#[napi]
pub fn add(a: i32, b: i32) -> napi::Result<i32> {
    catch_unwind_napi(|| Ok(a + b))
}

/// Throws a structured ReamError — validates error transport across NAPI.
#[napi]
pub fn throw_ream_error() -> napi::Result<String> {
    catch_unwind_napi(|| {
        Err(ream_error!("TEST_ERROR", "This is a test error")
            .with_hint("This hint should appear in TypeScript")
            .with_context("module", "napi-test")
            .with_docs_url("https://docs.ream.dev/errors/TEST_ERROR")
            .into())
    })
}

/// Panics inside catch_unwind — validates that Node.js doesn't crash.
#[napi]
pub fn trigger_panic() -> napi::Result<String> {
    catch_unwind_napi(|| {
        panic!("intentional panic for testing");
    })
}

/// Empty function for NAPI overhead measurement (NFR4: < 500ns per call).
#[napi]
pub fn noop() -> napi::Result<()> {
    catch_unwind_napi(|| Ok(()))
}

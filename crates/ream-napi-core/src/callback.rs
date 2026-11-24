//! ThreadsafeFunction helpers for Rust→JS callbacks.
//!
//! Each binding builds its callbacks with napi 3's builder, because each needs
//! its own shape (a weak handle for the scheduler and the event bus, typed
//! arguments and a promise for the HTTP server). What they share lives here:
//! the handle type that fixes the error strategy, and the coded error for a
//! callback that cannot be built.
//!
//! @implements AR2

use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;

/// The threadsafe function this crate hands out.
///
/// `CalleeHandled = false` is napi 3's spelling of napi 2's
/// `ErrorStrategy::Fatal`, and it is NOT napi 3's default — the default is
/// `true`, which PREPENDS a `null` so JavaScript is called as
/// `(err, payload)`. Every TypeScript wrapper on this surface takes the
/// payload FIRST, so accepting the default hands them `null`: the scheduler's
/// wrapper read `null.scheduledForMs` the moment the ticker fired (audit
/// 2026-05-22). It is spelled once, here, rather than
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

/// A JavaScript callback napi could not wrap in a threadsafe function:
/// `E_NATIVE_CALLBACK_FAILED`, carried as ream's JSON error so the
/// TypeScript boundary raises its class. napi's own status stays in the
/// message.
pub fn callback_failed(error: napi::Error) -> napi::Error {
    crate::ReamError::new(
        "E_NATIVE_CALLBACK_FAILED",
        format!("Could not hold the JavaScript callback: {error}"),
    )
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_callback_that_cannot_be_built_crosses_under_its_code() {
        let reason = callback_failed(napi::Error::new(Status::InvalidArg, "not a function")).reason;
        let payload: serde_json::Value = serde_json::from_str(&reason).unwrap();
        assert_eq!(payload["code"], "E_NATIVE_CALLBACK_FAILED");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("not a function"));
    }
}

//! SecurityFilter trait for Rust-side request filtering.
//!
//! Defines the interface that security implementations (like Blackhole)
//! must implement to filter requests before they cross NAPI.
//!
//! @implements FR43, FR44, FR45, FR46, FR47, AR3

use crate::request::ReamRequest;
use crate::response::ReamResponse;

/// Result of a security filter check.
pub enum FilterResult {
    /// Request is allowed — continue to NAPI handler
    Allow(ReamRequest),
    /// Request is sanitized — continue with modified request
    Sanitized(ReamRequest),
    /// Request is rejected — return response directly from Rust (no NAPI crossing)
    Reject(ReamResponse),
}

/// Trait for security filters that run in Rust before the NAPI boundary.
///
/// Implementations can:
/// - Allow requests unchanged
/// - Sanitize requests (e.g., strip XSS from query params)
/// - Reject requests entirely (rate limit, CSRF failure) — no NAPI crossing
///
/// The trait is optional: `ream-http` can run without a SecurityFilter.
pub trait SecurityFilter: Send + Sync {
    /// Check a request before it crosses the NAPI boundary.
    fn check(&self, request: ReamRequest) -> FilterResult;
}

/// A no-op filter that allows all requests unchanged.
/// Used when no SecurityFilter is configured.
pub struct NoopFilter;

impl SecurityFilter for NoopFilter {
    fn check(&self, request: ReamRequest) -> FilterResult {
        FilterResult::Allow(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_noop_filter_allows_all() {
        let filter = NoopFilter;
        let req = ReamRequest::from_hyper("GET", "/test", Default::default(), String::new());
        match filter.check(req) {
            FilterResult::Allow(r) => assert_eq!(r.path, "/test"),
            _ => panic!("NoopFilter should allow all requests"),
        }
    }

}

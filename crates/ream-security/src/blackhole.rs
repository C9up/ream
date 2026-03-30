//! Blackhole security filter — implements SecurityFilter for ream-http.
//!
//! Runs in Rust before the NAPI boundary. Rejected requests never reach Node.js.
//!
//! @implements FR43, FR44, FR45, FR46, FR47, AR3

use crate::csrf::CsrfValidator;
use crate::rate_limit::RateLimiter;
use crate::xss;
use std::sync::Mutex;

/// Configuration for the Blackhole security filter.
pub struct BlackholeConfig {
    /// Enable XSS sanitization (default: true)
    pub xss_enabled: bool,
    /// Enable CSRF validation (default: true)
    pub csrf_enabled: bool,
    /// Enable rate limiting (default: None — disabled)
    pub rate_limit: Option<(u32, u64)>, // (max_requests, window_secs)
}

impl Default for BlackholeConfig {
    fn default() -> Self {
        Self {
            xss_enabled: true,
            csrf_enabled: true,
            rate_limit: None,
        }
    }
}

/// Blackhole security filter.
///
/// Implements the `SecurityFilter` trait from `ream-http`.
/// Checks run in Rust before the request crosses NAPI to Node.js.
pub struct BlackholeFilter {
    config: BlackholeConfig,
    rate_limiter: Option<RateLimiter>,
    csrf_validator: Mutex<CsrfValidator>,
}

impl BlackholeFilter {
    pub fn new(config: BlackholeConfig) -> Self {
        let rate_limiter = config
            .rate_limit
            .map(|(max, window)| RateLimiter::new(max, window));

        Self {
            config,
            rate_limiter,
            csrf_validator: Mutex::new(CsrfValidator::new()),
        }
    }

    /// Generate a new CSRF token.
    pub fn generate_csrf_token(&self) -> String {
        let mut validator = self.csrf_validator.lock().unwrap_or_else(|e| e.into_inner());
        validator.generate_token()
    }

    /// Extract client IP from request headers (X-Forwarded-For or fallback).
    fn extract_client_ip(request: &ream_http::ReamRequest) -> String {
        request
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.split(',').next().map(|s| s.trim().to_string()))
            .unwrap_or_else(|| "unknown".to_string())
    }
}

impl ream_http::SecurityFilter for BlackholeFilter {
    fn check(&self, mut request: ream_http::ReamRequest) -> ream_http::FilterResult {
        // 1. Rate limiting check
        if let Some(ref limiter) = self.rate_limiter {
            let client_ip = Self::extract_client_ip(&request);
            if !limiter.check(&client_ip) {
                return ream_http::FilterResult::Reject(ream_http::ReamResponse::json(
                    429,
                    r#"{"error":{"code":"RATE_LIMITED","message":"Too many requests"}}"#,
                ));
            }
        }

        // 2. CSRF validation for state-changing methods
        if self.config.csrf_enabled && CsrfValidator::requires_csrf(&request.method) {
            let token = request.headers.get("x-csrf-token").cloned();
            let mut validator = self.csrf_validator.lock().unwrap_or_else(|e| e.into_inner());

            match token {
                Some(t) if validator.validate(&t) => {} // Valid token
                _ => {
                    return ream_http::FilterResult::Reject(ream_http::ReamResponse::json(
                        403,
                        r#"{"error":{"code":"CSRF_FAILED","message":"Invalid or missing CSRF token"}}"#,
                    ));
                }
            }
        }

        // 3. XSS sanitization — always apply when enabled (no detection guard)
        // This prevents bypass via unrecognized XSS vectors
        if self.config.xss_enabled {
            let orig_query = request.query.clone();
            let orig_body = request.body.clone();

            request.query = xss::sanitize_xss(&request.query);
            request.body = xss::sanitize_xss(&request.body);

            if request.query != orig_query || request.body != orig_body {
                return ream_http::FilterResult::Sanitized(request);
            }
        }

        ream_http::FilterResult::Allow(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ream_http::SecurityFilter;
    use std::collections::HashMap;

    fn make_request(method: &str, path: &str) -> ream_http::ReamRequest {
        ream_http::ReamRequest::from_hyper(method, path, HashMap::new(), String::new())
    }

    fn make_request_with_headers(
        method: &str,
        path: &str,
        headers: HashMap<String, String>,
        body: String,
    ) -> ream_http::ReamRequest {
        ream_http::ReamRequest::from_hyper(method, path, headers, body)
    }

    #[test]
    fn test_allows_normal_get() {
        let filter = BlackholeFilter::new(BlackholeConfig {
            csrf_enabled: false,
            ..Default::default()
        });
        let req = make_request("GET", "/api/orders");
        match filter.check(req) {
            ream_http::FilterResult::Allow(r) => assert_eq!(r.path, "/api/orders"),
            _ => panic!("Should allow normal GET"),
        }
    }

    #[test]
    fn test_rate_limiting_blocks() {
        let filter = BlackholeFilter::new(BlackholeConfig {
            rate_limit: Some((2, 60)),
            csrf_enabled: false,
            ..Default::default()
        });

        let mut headers = HashMap::new();
        headers.insert("x-forwarded-for".to_string(), "1.2.3.4".to_string());

        // First two requests pass
        let req1 = make_request_with_headers("GET", "/api", headers.clone(), String::new());
        assert!(matches!(filter.check(req1), ream_http::FilterResult::Allow(_)));

        let req2 = make_request_with_headers("GET", "/api", headers.clone(), String::new());
        assert!(matches!(filter.check(req2), ream_http::FilterResult::Allow(_)));

        // Third request blocked
        let req3 = make_request_with_headers("GET", "/api", headers.clone(), String::new());
        match filter.check(req3) {
            ream_http::FilterResult::Reject(res) => {
                assert_eq!(res.status, 429);
                assert!(res.body.contains("RATE_LIMITED"));
            }
            _ => panic!("Should reject rate-limited request"),
        }
    }

    #[test]
    fn test_csrf_blocks_post_without_token() {
        let filter = BlackholeFilter::new(BlackholeConfig::default());
        let req = make_request("POST", "/api/orders");
        match filter.check(req) {
            ream_http::FilterResult::Reject(res) => {
                assert_eq!(res.status, 403);
                assert!(res.body.contains("CSRF_FAILED"));
            }
            _ => panic!("Should reject POST without CSRF token"),
        }
    }

    #[test]
    fn test_csrf_allows_post_with_valid_token() {
        let filter = BlackholeFilter::new(BlackholeConfig::default());
        let token = filter.generate_csrf_token();

        let mut headers = HashMap::new();
        headers.insert("x-csrf-token".to_string(), token);

        let req = make_request_with_headers("POST", "/api/orders", headers, String::new());
        assert!(matches!(filter.check(req), ream_http::FilterResult::Allow(_)));
    }

    #[test]
    fn test_csrf_allows_get_without_token() {
        let filter = BlackholeFilter::new(BlackholeConfig::default());
        let req = make_request("GET", "/api/orders");
        assert!(matches!(filter.check(req), ream_http::FilterResult::Allow(_)));
    }

    #[test]
    fn test_xss_sanitizes_query() {
        let filter = BlackholeFilter::new(BlackholeConfig {
            csrf_enabled: false,
            ..Default::default()
        });
        let req = ream_http::ReamRequest::from_hyper(
            "GET",
            "/search?q=<script>alert(1)</script>",
            HashMap::new(),
            String::new(),
        );
        match filter.check(req) {
            ream_http::FilterResult::Sanitized(r) => {
                assert!(!r.query.contains("<script>"));
                assert!(r.query.contains("&lt;script&gt;"));
            }
            _ => panic!("Should sanitize XSS in query"),
        }
    }

    #[test]
    fn test_xss_sanitizes_body() {
        let filter = BlackholeFilter::new(BlackholeConfig {
            csrf_enabled: false,
            ..Default::default()
        });
        let req = make_request_with_headers(
            "POST",
            "/api/comments",
            HashMap::new(),
            "<script>evil()</script>".to_string(),
        );
        match filter.check(req) {
            ream_http::FilterResult::Sanitized(r) => {
                assert!(!r.body.contains("<script>"));
            }
            _ => panic!("Should sanitize XSS in body"),
        }
    }
}

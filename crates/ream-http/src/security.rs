//! Wire-level security pre-filter.
//!
//! Runs in Rust BEFORE the request crosses the NAPI boundary, so malformed
//! or hostile payloads (path-traversal sequences, parameter-pollution
//! attempts, CRLF-laced headers) are rejected at the edge instead of paying
//! the JS dispatch cost. Dormant by default (NoopFilter): the framework's
//! request-filter security now lives in @c9up/blackhole; this wire-level
//! shield stays available via `configure_shield` for advanced opt-in.
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
/// - Reject requests entirely (path traversal, param pollution) — no NAPI crossing
pub trait SecurityFilter: Send + Sync {
    /// Check a request before it crosses the NAPI boundary.
    fn check(&self, request: ReamRequest) -> FilterResult;
}

/// A no-op filter that allows all requests unchanged. Used when no
/// `SecurityFilter` is configured.
pub struct NoopFilter;

impl SecurityFilter for NoopFilter {
    fn check(&self, request: ReamRequest) -> FilterResult {
        FilterResult::Allow(request)
    }
}

/// Configuration for `ShieldFilter`. Each flag toggles one rule on/off so
/// applications can opt out of individual checks (e.g. disable param-
/// pollution detection on endpoints that legitimately accept duplicate
/// keys without `[]` suffix).
#[derive(Debug, Clone, Copy)]
pub struct ShieldConfig {
    /// Reject requests whose path contains `..` literal, `%2e%2e`
    /// (case-insensitive percent-encoded `..`), or `%252e` (double-encoded
    /// `.`). Defaults to true.
    pub path_traversal: bool,
    /// Reject requests whose query string carries the same key twice (after
    /// percent-decoding), unless the key ends with `[]` to opt into array
    /// semantics. Defaults to true.
    pub param_pollution: bool,
}

impl Default for ShieldConfig {
    fn default() -> Self {
        Self { path_traversal: true, param_pollution: true }
    }
}

/// Wire-level shield: rejects path-traversal and parameter-pollution
/// attempts before the request crosses NAPI.
pub struct ShieldFilter {
    config: ShieldConfig,
}

impl ShieldFilter {
    pub fn new(config: ShieldConfig) -> Self {
        Self { config }
    }

    fn reject_traversal() -> ReamResponse {
        ReamResponse::json(
            400,
            r#"{"error":{"code":"E_PATH_TRAVERSAL","message":"Path traversal detected"}}"#,
        )
    }

    fn reject_pollution(key: &str) -> ReamResponse {
        // Quote-escape the key so an attacker-controlled value can't break
        // out of the JSON envelope.
        let escaped = key
            .replace('\\', r"\\")
            .replace('"', r#"\""#);
        ReamResponse::json(
            400,
            format!(
                r#"{{"error":{{"code":"E_PARAMETER_POLLUTION","message":"Duplicate parameter: {}"}}}}"#,
                escaped
            ),
        )
    }
}

impl SecurityFilter for ShieldFilter {
    fn check(&self, request: ReamRequest) -> FilterResult {
        if self.config.path_traversal && contains_traversal(&request.path) {
            return FilterResult::Reject(Self::reject_traversal());
        }

        if self.config.param_pollution {
            if let Some(dup) = first_duplicate_key(&request.query) {
                return FilterResult::Reject(Self::reject_pollution(&dup));
            }
        }

        FilterResult::Allow(request)
    }
}

/// Whether the path matches one of the traversal patterns. Case-insensitive
/// for percent-encoded forms — `%2E%2E`, `%2e%2e` and `%252e` all decode to
/// `..` somewhere in the request pipeline.
fn contains_traversal(path: &str) -> bool {
    if path.contains("..") {
        return true;
    }
    let lower = path.to_ascii_lowercase();
    lower.contains("%2e%2e") || lower.contains("%252e")
}

/// Walk the raw query string and surface the first duplicate key (after
/// percent-decoding). Keys ending with `[]` are intentionally allowed to
/// repeat — that's the framework's array-input convention.
fn first_duplicate_key(query: &str) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let mut seen: Vec<String> = Vec::new();
    for pair in query.split('&') {
        let raw_key = pair.split('=').next().unwrap_or("");
        if raw_key.is_empty() {
            continue;
        }
        let key = match urlencoding::decode(raw_key) {
            Ok(decoded) => decoded.into_owned(),
            Err(_) => raw_key.to_string(),
        };
        if key.ends_with("[]") {
            continue;
        }
        if seen.iter().any(|k| k == &key) {
            return Some(key);
        }
        seen.push(key);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn req(path: &str, query: &str) -> ReamRequest {
        ReamRequest::from_hyper(
            "GET",
            &if query.is_empty() { path.to_string() } else { format!("{}?{}", path, query) },
            HashMap::new(),
            String::new(),
        )
    }

    fn shield() -> ShieldFilter {
        ShieldFilter::new(ShieldConfig::default())
    }

    #[test]
    fn noop_filter_allows_all() {
        match NoopFilter.check(req("/test", "")) {
            FilterResult::Allow(r) => assert_eq!(r.path, "/test"),
            _ => panic!("NoopFilter should allow all requests"),
        }
    }

    #[test]
    fn shield_passes_clean_request() {
        match shield().check(req("/orders/123", "page=1&limit=20")) {
            FilterResult::Allow(_) => {}
            _ => panic!("clean request should be allowed"),
        }
    }

    #[test]
    fn shield_rejects_literal_dot_dot() {
        match shield().check(req("/download/../etc/passwd", "")) {
            FilterResult::Reject(res) => {
                assert_eq!(res.status, 400);
                assert!(res.body.contains("E_PATH_TRAVERSAL"));
            }
            _ => panic!("literal `..` must be rejected"),
        }
    }

    #[test]
    fn shield_rejects_uppercase_percent_encoded_traversal() {
        match shield().check(req("/download/%2E%2E/%2E%2E/etc/passwd", "")) {
            FilterResult::Reject(res) => assert_eq!(res.status, 400),
            _ => panic!("uppercase %2E%2E must be rejected"),
        }
    }

    #[test]
    fn shield_rejects_double_encoded_traversal() {
        match shield().check(req("/x/%252e/y", "")) {
            FilterResult::Reject(_) => {}
            _ => panic!("double-encoded `%252e` must be rejected"),
        }
    }

    #[test]
    fn shield_rejects_duplicate_query_key_decoded() {
        // %61 == 'a' — the second arrival is a duplicate of the first
        match shield().check(req("/api/search", "a=1&%61=2")) {
            FilterResult::Reject(res) => {
                assert_eq!(res.status, 400);
                assert!(res.body.contains("Duplicate parameter: a"));
            }
            _ => panic!("decoded duplicate key must be rejected"),
        }
    }

    #[test]
    fn shield_allows_array_brackets_repetition() {
        match shield().check(req("/api/list", "tag[]=red&tag[]=blue")) {
            FilterResult::Allow(_) => {}
            _ => panic!("`[]` keys are array semantics — must be allowed"),
        }
    }

    #[test]
    fn shield_respects_path_traversal_disabled() {
        let f = ShieldFilter::new(ShieldConfig { path_traversal: false, param_pollution: true });
        match f.check(req("/x/../y", "")) {
            FilterResult::Allow(_) => {}
            _ => panic!("disabled path-traversal check must let `..` through"),
        }
    }

    #[test]
    fn shield_respects_param_pollution_disabled() {
        let f = ShieldFilter::new(ShieldConfig { path_traversal: true, param_pollution: false });
        match f.check(req("/x", "a=1&a=2")) {
            FilterResult::Allow(_) => {}
            _ => panic!("disabled param-pollution check must let duplicates through"),
        }
    }

    #[test]
    fn pollution_message_escapes_quotes() {
        let f = shield();
        // Decoded key contains a literal `"` — must not break the JSON envelope.
        match f.check(req("/x", r#"%22a%22=1&%22a%22=2"#)) {
            FilterResult::Reject(res) => {
                assert!(res.body.starts_with('{'));
                assert!(res.body.ends_with('}'));
                // Body parses as valid JSON
                let parsed: serde_json::Value = serde_json::from_str(&res.body).unwrap();
                assert_eq!(parsed["error"]["code"], "E_PARAMETER_POLLUTION");
            }
            _ => panic!("must reject and emit valid JSON"),
        }
    }
}

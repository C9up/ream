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
    /// Reject requests whose path holds a `..` segment once decoded: literal,
    /// percent-encoded in full or in part (`%2e%2e`, `.%2e`, `%2e.`),
    /// double-encoded (`%252e%252e`), overlong UTF-8 (`%c0%ae`), or split by
    /// an encoded separator (`..%2f`, `..%5c`, `\`). A double-encoded dot
    /// (`%252e`) is refused wherever it appears. A dot run inside a name
    /// (`a..b`) is not a traversal and passes. Defaults to true.
    pub path_traversal: bool,
    /// Reject requests whose query string carries the same key twice (after
    /// percent-decoding), unless the key ends with `[]` to opt into array
    /// semantics. Defaults to true.
    pub param_pollution: bool,
}

impl Default for ShieldConfig {
    fn default() -> Self {
        Self {
            path_traversal: true,
            param_pollution: true,
        }
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
        let escaped = key.replace('\\', r"\\").replace('"', r#"\""#);
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

/// How many times the path is percent-decoded while looking for a `..`
/// segment. Three rounds reach a triple-encoded dot (`%25252e`); anything
/// deeper is still refused by the `%252e` rule.
const TRAVERSAL_DECODE_ROUNDS: usize = 3;

/// Whether the path climbs out of its directory once decoded. The raw path
/// and each decoded form (up to [`TRAVERSAL_DECODE_ROUNDS`]) are split on `/`
/// and `\\` — a decoded `%2f` / `%5c` becomes a separator — and refused when
/// a segment is a dot-dot. Case-insensitive for the encoded forms.
fn contains_traversal(path: &str) -> bool {
    // A double-encoded dot has no legitimate use in a path: refused as such,
    // whatever it decodes to.
    if path.to_ascii_lowercase().contains("%252e") {
        return true;
    }
    let mut current = path.as_bytes().to_vec();
    for _ in 0..=TRAVERSAL_DECODE_ROUNDS {
        if has_dot_dot_segment(&current) {
            return true;
        }
        let decoded = percent_decode(&current);
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    false
}

/// A segment is a dot-dot when it is made of two or more dots, trailing
/// spaces aside: Windows drops trailing dots and spaces from a path
/// component, so `...` and `.. ` reach the file system as `..`.
fn has_dot_dot_segment(path: &[u8]) -> bool {
    path.split(|b| *b == b'/' || *b == b'\\').any(|segment| {
        let trimmed = trim_trailing_spaces(segment);
        trimmed.len() >= 2 && trimmed.iter().all(|b| *b == b'.')
    })
}

fn trim_trailing_spaces(segment: &[u8]) -> &[u8] {
    let end = segment
        .iter()
        .rposition(|b| *b != b' ')
        .map_or(0, |last| last + 1);
    &segment[..end]
}

/// Percent-decode bytes, leaving a malformed escape as it is, and fold the
/// overlong UTF-8 encodings of ASCII (`%c0%ae` for `.`, `%c0%af` for `/`,
/// `%e0%80%ae`...) to the character they spell, as lenient decoders do.
fn percent_decode(input: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let byte = input[i];
        if byte == b'%' && i + 2 < input.len() {
            if let (Some(hi), Some(lo)) = (hex_value(input[i + 1]), hex_value(input[i + 2])) {
                bytes.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        bytes.push(byte);
        i += 1;
    }
    fold_overlong_ascii(&bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Replace two- and three-byte overlong encodings of an ASCII character
/// (`C0 AE`, `E0 80 AE`) by that character. Every other byte is kept.
fn fold_overlong_ascii(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let continuation = |at: usize| bytes.get(at).filter(|b| **b & 0xC0 == 0x80).copied();
        if b0 == 0xC0 || b0 == 0xC1 {
            if let Some(b1) = continuation(i + 1) {
                out.push(((b0 & 0x1F) << 6) | (b1 & 0x3F));
                i += 2;
                continue;
            }
        }
        if b0 == 0xE0 {
            if let (Some(0x80), Some(b2)) = (continuation(i + 1), continuation(i + 2)) {
                out.push(b2 & 0x3F);
                i += 3;
                continue;
            }
            if let (Some(0x81), Some(b2)) = (continuation(i + 1), continuation(i + 2)) {
                out.push(0x40 | (b2 & 0x3F));
                i += 3;
                continue;
            }
        }
        out.push(b0);
        i += 1;
    }
    out
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
            &if query.is_empty() {
                path.to_string()
            } else {
                format!("{}?{}", path, query)
            },
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

    fn assert_rejected(path: &str) {
        match shield().check(req(path, "")) {
            FilterResult::Reject(res) => {
                assert_eq!(res.status, 400, "{path}");
                assert!(res.body.contains("E_PATH_TRAVERSAL"), "{path}");
            }
            _ => panic!("`{path}` must be rejected as a traversal"),
        }
    }

    fn assert_allowed(path: &str) {
        match shield().check(req(path, "")) {
            FilterResult::Allow(_) => {}
            _ => panic!("`{path}` must be allowed"),
        }
    }

    #[test]
    fn shield_rejects_half_encoded_dot_dot() {
        assert_rejected("/static/.%2e/etc/passwd");
        assert_rejected("/static/%2e./etc/passwd");
        assert_rejected("/static/.%2E/etc/passwd");
        assert_rejected("/static/%2E.");
    }

    #[test]
    fn shield_rejects_double_encoded_dot_dot_in_every_mix() {
        assert_rejected("/static/%252e%252e/x");
        assert_rejected("/static/.%252e/x");
        assert_rejected("/static/%25252e%25252e/x");
    }

    #[test]
    fn shield_rejects_dot_dot_split_by_an_encoded_separator() {
        assert_rejected("/static/..%2fetc/passwd");
        assert_rejected("/static/..%5cetc");
        assert_rejected("/static/%2e%2e%5cetc");
        assert_rejected("/static\\..\\etc");
        assert_rejected("/static/x%2f..%2f..%2fetc");
    }

    #[test]
    fn shield_rejects_overlong_utf8_dots() {
        assert_rejected("/static/%c0%ae%c0%ae/etc");
        assert_rejected("/static/%C0%AE./etc");
        assert_rejected("/static/%e0%80%ae%e0%80%ae/etc");
        assert_rejected("/static/..%c0%afetc");
    }

    #[test]
    fn shield_rejects_dot_runs_windows_reads_as_dot_dot() {
        assert_rejected("/static/.../etc");
        assert_rejected("/static/..%20/etc");
        assert_rejected("/static/..");
    }

    #[test]
    fn shield_allows_dots_inside_a_name() {
        assert_allowed("/files/a..b");
        assert_allowed("/files/..hidden");
        assert_allowed("/files/name..");
        assert_allowed("/files/v1.2.3/./readme");
        assert_allowed("/files/%2e/readme");
        assert_allowed("/files/report%2epdf");
        assert_allowed("/files/100%25");
    }

    #[test]
    fn shield_tolerates_malformed_escapes() {
        assert_allowed("/files/%zz/%2");
        assert_allowed("/files/%");
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
        let f = ShieldFilter::new(ShieldConfig {
            path_traversal: false,
            param_pollution: true,
        });
        match f.check(req("/x/../y", "")) {
            FilterResult::Allow(_) => {}
            _ => panic!("disabled path-traversal check must let `..` through"),
        }
    }

    #[test]
    fn shield_respects_param_pollution_disabled() {
        let f = ShieldFilter::new(ShieldConfig {
            path_traversal: true,
            param_pollution: false,
        });
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

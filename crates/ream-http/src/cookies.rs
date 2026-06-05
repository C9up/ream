//! `Cookie` request-header parser. Replaces the JS `parseCookie` /
//! `parseAllCookies` regex pair on the inbound side: the HyperServer parses
//! `Cookie:` once at the wire and ships the typed map on `request.cookies`.
//!
//! The `cookie` crate handles RFC 6265 quoted values, token validation, and
//! percent-decoding correctly — replaces a hand-rolled `;`-split that mishandled
//! `value="abc"`-style quoted forms.

use cookie::Cookie;
use std::collections::HashMap;

/// Parse a `Cookie:` header value into a name → value map. Repeated names
/// surface the LAST occurrence (matches the JS pre-migration semantics —
/// browsers don't typically send duplicates anyway).
///
/// Malformed pairs are skipped, never thrown — a single bad cookie must not
/// bring down the request handler.
pub fn parse_cookie_header(header: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if header.is_empty() {
        return map;
    }
    for pair in header.split(';') {
        let trimmed = pair.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(cookie) = Cookie::parse(trimmed) {
            map.insert(cookie.name().to_string(), cookie.value().to_string());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_pair() {
        let parsed = parse_cookie_header("session=abc123");
        assert_eq!(parsed.get("session"), Some(&"abc123".to_string()));
    }

    #[test]
    fn parses_multiple_pairs() {
        let parsed = parse_cookie_header("a=1; b=2; c=3");
        assert_eq!(parsed.get("a"), Some(&"1".to_string()));
        assert_eq!(parsed.get("b"), Some(&"2".to_string()));
        assert_eq!(parsed.get("c"), Some(&"3".to_string()));
    }

    #[test]
    fn preserves_quoted_value_envelope() {
        // RFC 6265 §4.2 doesn't mandate stripping the surrounding quotes —
        // the value comes back with them attached. Document this so future
        // callers don't expect the inner string.
        let parsed = parse_cookie_header(r#"token="opaque-value""#);
        assert_eq!(parsed.get("token"), Some(&r#""opaque-value""#.to_string()));
    }

    #[test]
    fn skips_malformed_pairs_without_failing() {
        let parsed = parse_cookie_header("ok=1; bad-no-equals; also=fine");
        assert_eq!(parsed.get("ok"), Some(&"1".to_string()));
        assert_eq!(parsed.get("also"), Some(&"fine".to_string()));
    }

    #[test]
    fn handles_values_with_equals_in_them() {
        // Base64-padded JWT-style values often contain `=`. The split-on-first-=
        // semantics must preserve them.
        let parsed = parse_cookie_header("session=eyJhbGc=.eyJzdWI=.SIGN==");
        assert_eq!(parsed.get("session"), Some(&"eyJhbGc=.eyJzdWI=.SIGN==".to_string()));
    }

    #[test]
    fn empty_header_yields_empty_map() {
        assert!(parse_cookie_header("").is_empty());
    }

    #[test]
    fn malformed_percent_encoding_does_not_throw() {
        // The hand-rolled JS parser returned the value verbatim on bad
        // percent-encoded input; the cookie crate is similarly tolerant —
        // never reject the whole header for one bad byte sequence.
        let parsed = parse_cookie_header("a=%E0%A4%A");
        assert_eq!(parsed.get("a"), Some(&"%E0%A4%A".to_string()));
    }
}

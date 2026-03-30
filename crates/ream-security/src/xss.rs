//! XSS sanitization utilities.
//!
//! @implements FR44

/// Sanitize a string by escaping common XSS patterns.
pub fn sanitize_xss(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

/// Check if a string contains potential XSS patterns.
pub fn contains_xss(input: &str) -> bool {
    let lower = input.to_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("onclick=")
        || lower.contains("onfocus=")
        || lower.contains("onmouseover=")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_xss() {
        assert_eq!(sanitize_xss("<script>alert('xss')</script>"),
            "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;");
    }

    #[test]
    fn test_sanitize_normal_text() {
        assert_eq!(sanitize_xss("hello world"), "hello world");
    }

    #[test]
    fn test_contains_xss_script_tag() {
        assert!(contains_xss("<script>alert(1)</script>"));
        assert!(contains_xss("<SCRIPT>alert(1)</SCRIPT>"));
    }

    #[test]
    fn test_contains_xss_event_handlers() {
        assert!(contains_xss("onerror=alert(1)"));
        assert!(contains_xss("onload=fetch('evil')"));
    }

    #[test]
    fn test_contains_xss_javascript_uri() {
        assert!(contains_xss("javascript:alert(1)"));
    }

    #[test]
    fn test_no_xss() {
        assert!(!contains_xss("Hello World"));
        assert!(!contains_xss("/api/orders?page=1"));
    }
}

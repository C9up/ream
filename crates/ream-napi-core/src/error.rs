//! Structured error type for Rust→NAPI→TS error wrapping.
//!
//! `ReamError` provides rich error context that crosses the NAPI boundary
//! and can be reconstructed as a typed error in TypeScript.
//!
//! @implements AR2, FR71

use serde::Serialize;
use std::collections::HashMap;
use std::fmt;

/// Structured error that crosses the Rust→NAPI→TypeScript boundary.
///
/// When converted to a `napi::Error`, the error is serialized as JSON
/// in the message field, allowing the TypeScript `ReamError` class to
/// parse and reconstruct a rich error with code, context, hint, and docs URL.
///
/// # Example
///
/// ```
/// use ream_napi_core::ReamError;
///
/// let err = ReamError::new("ATLAS_QUERY_ERROR", "Column 'statut' not found")
///     .with_hint("Did you mean: status?")
///     .with_context("entity", "Order")
///     .with_source_location(file!(), line!())
///     .with_docs_url("https://docs.ream.dev/errors/ATLAS_QUERY_ERROR");
/// ```
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReamError {
    /// Error code identifier (e.g., "ATLAS_RELATION_NOT_FOUND")
    pub code: String,

    /// Human-readable error message
    pub message: String,

    /// Additional context key-value pairs
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub context: HashMap<String, String>,

    /// Actionable hint for the developer
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,

    /// Rust source file where the error originated
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,

    /// Line number in the source file
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_line: Option<u32>,

    /// URL to the error documentation page
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

impl ReamError {
    /// Create a new ReamError with code and message.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            context: HashMap::new(),
            hint: None,
            source_file: None,
            source_line: None,
            docs_url: None,
        }
    }

    /// Add an actionable hint.
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Add a context key-value pair.
    pub fn with_context(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.context.insert(key.into(), value.into());
        self
    }

    /// Set the source file and line number.
    pub fn with_source_location(mut self, file: &str, line: u32) -> Self {
        self.source_file = Some(file.to_string());
        self.source_line = Some(line);
        self
    }

    /// Set the documentation URL.
    pub fn with_docs_url(mut self, url: impl Into<String>) -> Self {
        self.docs_url = Some(url.into());
        self
    }

    /// Serialize the error to JSON for NAPI transport.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            serde_json::json!({"code": self.code, "message": self.message}).to_string()
        })
    }
}

impl fmt::Display for ReamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        if let Some(ref hint) = self.hint {
            write!(f, " (hint: {})", hint)?;
        }
        Ok(())
    }
}

impl std::error::Error for ReamError {}

impl From<ReamError> for napi::Error {
    fn from(err: ReamError) -> Self {
        napi::Error::new(napi::Status::GenericFailure, err.to_json())
    }
}

/// Convenience macro to create a ReamError with automatic source location.
///
/// # Example
///
/// ```
/// use ream_napi_core::ream_error;
///
/// let err = ream_error!("MY_CODE", "Something went wrong");
/// assert!(err.source_file.is_some());
/// assert!(err.source_line.is_some());
/// ```
#[macro_export]
macro_rules! ream_error {
    ($code:expr, $message:expr) => {
        $crate::ReamError::new($code, $message).with_source_location(file!(), line!())
    };
    ($code:expr, $message:expr, $($key:expr => $value:expr),+) => {
        {
            let mut err = $crate::ReamError::new($code, $message).with_source_location(file!(), line!());
            $(err = err.with_context($key, $value);)+
            err
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_creation() {
        let err = ReamError::new("TEST_ERROR", "Test message");
        assert_eq!(err.code, "TEST_ERROR");
        assert_eq!(err.message, "Test message");
        assert!(err.context.is_empty());
        assert!(err.hint.is_none());
    }

    #[test]
    fn test_error_builder_pattern() {
        let err = ReamError::new("ATLAS_QUERY_ERROR", "Column not found")
            .with_hint("Did you mean: status?")
            .with_context("entity", "Order")
            .with_context("column", "statut")
            .with_source_location("src/query.rs", 42)
            .with_docs_url("https://docs.ream.dev/errors/ATLAS_QUERY_ERROR");

        assert_eq!(err.hint.as_deref(), Some("Did you mean: status?"));
        assert_eq!(err.context.get("entity").map(|s| s.as_str()), Some("Order"));
        assert_eq!(err.context.get("column").map(|s| s.as_str()), Some("statut"));
        assert_eq!(err.source_file.as_deref(), Some("src/query.rs"));
        assert_eq!(err.source_line, Some(42));
        assert_eq!(
            err.docs_url.as_deref(),
            Some("https://docs.ream.dev/errors/ATLAS_QUERY_ERROR")
        );
    }

    #[test]
    fn test_error_display() {
        let err = ReamError::new("MY_CODE", "Something broke")
            .with_hint("Try this fix");
        assert_eq!(format!("{}", err), "[MY_CODE] Something broke (hint: Try this fix)");
    }

    #[test]
    fn test_error_display_no_hint() {
        let err = ReamError::new("MY_CODE", "Something broke");
        assert_eq!(format!("{}", err), "[MY_CODE] Something broke");
    }

    #[test]
    fn test_error_to_json_camelcase() {
        let err = ReamError::new("TEST", "msg")
            .with_context("key", "val")
            .with_source_location("test.rs", 10)
            .with_docs_url("https://docs.ream.dev/errors/TEST");
        let json = err.to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["code"], "TEST");
        assert_eq!(parsed["message"], "msg");
        assert_eq!(parsed["context"]["key"], "val");
        // Verify camelCase serialization
        assert_eq!(parsed["sourceFile"], "test.rs");
        assert_eq!(parsed["sourceLine"], 10);
        assert_eq!(parsed["docsUrl"], "https://docs.ream.dev/errors/TEST");
        // hint is None, should not be in JSON
        assert!(parsed.get("hint").is_none());
        // snake_case keys should NOT exist
        assert!(parsed.get("source_file").is_none());
        assert!(parsed.get("docs_url").is_none());
    }

    #[test]
    fn test_error_to_napi() {
        let err = ReamError::new("NAPI_TEST", "test error");
        let napi_err: napi::Error = err.into();
        let reason = napi_err.reason;
        assert!(reason.contains("NAPI_TEST"));
        assert!(reason.contains("test error"));
    }

    #[test]
    fn test_ream_error_macro() {
        let err = ream_error!("MACRO_TEST", "macro error");
        assert_eq!(err.code, "MACRO_TEST");
        assert!(err.source_file.is_some());
        assert!(err.source_line.is_some());
    }

    #[test]
    fn test_ream_error_macro_with_context() {
        let err = ream_error!("CTX_TEST", "context error", "key1" => "val1", "key2" => "val2");
        assert_eq!(err.code, "CTX_TEST");
        assert_eq!(err.context.get("key1").map(|s| s.as_str()), Some("val1"));
        assert_eq!(err.context.get("key2").map(|s| s.as_str()), Some("val2"));
    }
}

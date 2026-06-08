//! HTTP response representation for NAPI transport.
//!
//! @implements FR23

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// HTTP response data that crosses the TS→NAPI→Rust boundary.
///
/// The TypeScript handler returns this struct, which is deserialized
/// in Rust and converted to a hyper Response.
///
/// When `stream_id` is `Some`, `body` is ignored and the hyper response
/// is built from the matching entry in
/// [`StreamRegistry`](crate::stream_registry::StreamRegistry) — the JS
/// handler keeps pushing frames over NAPI for as long as the connection
/// stays open. Used for SSE and any other long-lived response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReamResponse {
    /// HTTP status code (200, 404, 500, etc.)
    #[serde(default = "default_status")]
    pub status: u16,

    /// Response headers
    #[serde(default)]
    pub headers: HashMap<String, String>,

    /// Response body as UTF-8 string
    #[serde(default)]
    pub body: String,

    /// When set, switch this response into streaming mode. The hyper
    /// body is fed from the matching entry in the `StreamRegistry`
    /// (JS-driven chunks via the NAPI `writeStream` call). `body` is
    /// ignored in that case — write the first chunk via `writeStream`
    /// if you need a preamble.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
}

fn default_status() -> u16 {
    200
}

impl Default for ReamResponse {
    fn default() -> Self {
        Self {
            status: 200,
            headers: HashMap::new(),
            body: String::new(),
            stream_id: None,
        }
    }
}

impl ReamResponse {
    /// Create a simple text response.
    pub fn text(status: u16, body: impl Into<String>) -> Self {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "text/plain".to_string());
        Self {
            status,
            headers,
            body: body.into(),
            stream_id: None,
        }
    }

    /// Create a JSON response.
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        Self {
            status,
            headers,
            body: body.into(),
            stream_id: None,
        }
    }

    /// True when this response defers its body to a streaming source.
    /// The buffered-body sanitizer pipeline must be skipped in that
    /// case — passing an SSE wire format through HTML sanitization
    /// would mangle `\n\n` event separators.
    pub fn is_streaming(&self) -> bool {
        self.stream_id.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_response() {
        let res = ReamResponse::default();
        assert_eq!(res.status, 200);
        assert!(res.body.is_empty());
    }

    #[test]
    fn test_text_response() {
        let res = ReamResponse::text(200, "hello");
        assert_eq!(res.status, 200);
        assert_eq!(res.body, "hello");
        assert_eq!(res.headers.get("content-type").unwrap(), "text/plain");
    }

    #[test]
    fn test_json_response() {
        let res = ReamResponse::json(201, r#"{"id":"123"}"#);
        assert_eq!(res.status, 201);
        assert_eq!(res.headers.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn test_response_deserialize_with_defaults() {
        let json = r#"{"body":"ok"}"#;
        let res: ReamResponse = serde_json::from_str(json).unwrap();
        assert_eq!(res.status, 200); // default
        assert_eq!(res.body, "ok");
    }
}

//! HTTP request representation for NAPI transport.
//!
//! @implements FR23

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// HTTP request data that crosses the Rust→NAPI→TS boundary.
///
/// Serialized via serde so it can be passed through ThreadsafeFunction
/// to the TypeScript request handler.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReamRequest {
    /// HTTP method (GET, POST, PUT, DELETE, etc.)
    pub method: String,

    /// Request path (e.g., "/api/v1/orders")
    pub path: String,

    /// Query string without leading ? (e.g., "page=1&limit=20")
    #[serde(default)]
    pub query: String,

    /// HTTP headers as key-value pairs (header names lowercased)
    #[serde(default)]
    pub headers: HashMap<String, String>,

    /// Request body as UTF-8 string (empty for GET/DELETE)
    #[serde(default)]
    pub body: String,
}

impl ReamRequest {
    /// Create a ReamRequest from a hyper Request.
    pub fn from_hyper(method: &str, uri: &str, headers: HashMap<String, String>, body: String) -> Self {
        let (path, query) = match uri.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (uri.to_string(), String::new()),
        };

        Self {
            method: method.to_string(),
            path,
            query,
            headers,
            body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_from_hyper_with_query() {
        let req = ReamRequest::from_hyper("GET", "/api/orders?page=1&limit=20", HashMap::new(), String::new());
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/api/orders");
        assert_eq!(req.query, "page=1&limit=20");
    }

    #[test]
    fn test_request_from_hyper_without_query() {
        let req = ReamRequest::from_hyper("POST", "/api/orders", HashMap::new(), "{}".to_string());
        assert_eq!(req.path, "/api/orders");
        assert_eq!(req.query, "");
        assert_eq!(req.body, "{}");
    }

    #[test]
    fn test_request_serializes_camelcase() {
        let req = ReamRequest::from_hyper("GET", "/test", HashMap::new(), String::new());
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"method\""));
        assert!(json.contains("\"path\""));
        // camelCase check — no snake_case keys
        assert!(!json.contains("\"query_string\""));
    }
}

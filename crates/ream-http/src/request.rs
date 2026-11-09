//! HTTP request representation for NAPI transport.
//!
//! @implements FR23

use crate::multipart::MultipartPayload;
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

    /// Request body as UTF-8 string (empty for GET/DELETE).
    /// For multipart bodies, this is base64-encoded to preserve binary integrity.
    #[serde(default)]
    pub body: String,

    /// Body encoding: "utf8" (default) or "base64" (for multipart/binary bodies).
    #[serde(default = "default_body_encoding")]
    pub body_encoding: String,

    /// TCP peer address (actual remote socket). Unlike X-Forwarded-For, this cannot be spoofed.
    /// Used by the rate limiter and any middleware that needs the real client IP.
    #[serde(default)]
    pub remote_addr: String,

    /// Resolved client IP — the value JS-side `request.ip()` returns: the
    /// last entry of `ips`. Computed once by the server from the trusted
    /// proxies (see `crate::ip`); without any, it is `remote_addr`.
    #[serde(default)]
    pub ip: String,

    /// The trusted address chain, closest hop first: the socket peer, then
    /// each `X-Forwarded-For` entry walked right to left while the previous
    /// hop is a trusted proxy. Its last entry is `ip`. Adonis `request.ips()`
    /// (`proxy-addr`'s `all`).
    #[serde(default)]
    pub ips: Vec<String>,

    /// Whether the socket peer is one of the trusted proxies — the condition
    /// under which `X-Forwarded-Proto` / `X-Forwarded-Host` are believed,
    /// whether or not the proxy also sent `X-Forwarded-For`.
    #[serde(default)]
    pub peer_trusted: bool,

    /// The body was over its content type's limit: it was not kept, `body` is
    /// empty and must not be read as the request's body. The body parser
    /// answers 413 for it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub body_too_large: bool,

    /// Pre-parsed `multipart/form-data` payload. Set when the server detected
    /// a multipart content-type and successfully parsed the body via the
    /// `multer` crate. JS reads this directly — no regex parser on the JS
    /// side. `None` for non-multipart requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multipart: Option<MultipartPayload>,

    /// Pre-parsed `Cookie:` request header — name → value map. Computed once
    /// by the server using the `cookie` crate (RFC 6265). JS reads via
    /// `request.cookie(name)` / `request.cookies()` instead of re-splitting
    /// the raw header.
    #[serde(default)]
    pub cookies: HashMap<String, String>,
}

fn default_body_encoding() -> String {
    "utf8".to_string()
}

impl ReamRequest {
    /// Create a ReamRequest from a hyper Request.
    pub fn from_hyper(
        method: &str,
        uri: &str,
        headers: HashMap<String, String>,
        body: String,
    ) -> Self {
        Self::from_hyper_with_addr(method, uri, headers, body, String::new())
    }

    /// Create a ReamRequest including the TCP peer address.
    pub fn from_hyper_with_addr(
        method: &str,
        uri: &str,
        headers: HashMap<String, String>,
        body: String,
        remote_addr: String,
    ) -> Self {
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
            body_encoding: "utf8".to_string(),
            remote_addr,
            ip: String::new(),
            ips: Vec::new(),
            peer_trusted: false,
            body_too_large: false,
            multipart: None,
            cookies: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_from_hyper_with_query() {
        let req = ReamRequest::from_hyper(
            "GET",
            "/api/orders?page=1&limit=20",
            HashMap::new(),
            String::new(),
        );
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

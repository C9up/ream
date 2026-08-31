//! WebSocket upgrade support for the Ream HTTP server.
//!
//! Handles the HTTP → WebSocket upgrade handshake in Rust.
//! Once upgraded, frames are managed by tokio-tungstenite.
//!
//! The TS layer receives parsed messages and sends responses via NAPI callbacks.

use base64::Engine;
use sha1::{Digest, Sha1};

/// WebSocket magic string from RFC 6455.
const WS_MAGIC: &str = "258EAFA5-E914-47DA-95CA-5AB4D34150D3";

/// Check if a request is a WebSocket upgrade request.
pub fn is_websocket_upgrade(headers: &std::collections::HashMap<String, String>) -> bool {
    let upgrade = headers.get("upgrade").map(|v| v.to_lowercase());
    let connection = headers.get("connection").map(|v| v.to_lowercase());

    upgrade.as_deref() == Some("websocket")
        && connection.map_or(false, |c| c.contains("upgrade"))
        && headers.contains_key("sec-websocket-key")
}

/// Generate the Sec-WebSocket-Accept header value from the client's key.
pub fn websocket_accept_key(client_key: &str) -> String {
    let mut hasher = Sha1::new();
    let concat = format!("{}{}", client_key.trim(), WS_MAGIC);
    hasher.update(concat.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

/// Build the 101 Switching Protocols response headers for WebSocket upgrade.
pub fn upgrade_response_headers(client_key: &str) -> Vec<(String, String)> {
    let accept = websocket_accept_key(client_key);
    vec![
        ("Upgrade".to_string(), "websocket".to_string()),
        ("Connection".to_string(), "Upgrade".to_string()),
        ("Sec-WebSocket-Accept".to_string(), accept),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_is_websocket_upgrade() {
        let mut headers = HashMap::new();
        headers.insert("upgrade".to_string(), "websocket".to_string());
        headers.insert("connection".to_string(), "Upgrade".to_string());
        headers.insert(
            "sec-websocket-key".to_string(),
            "dGhlIHNhbXBsZSBub25jZQ==".to_string(),
        );

        assert!(is_websocket_upgrade(&headers));
    }

    #[test]
    fn test_not_websocket() {
        let headers = HashMap::new();
        assert!(!is_websocket_upgrade(&headers));
    }

    #[test]
    fn test_websocket_accept_key() {
        // Verified with Python: hashlib.sha1(key + magic).digest() → base64
        let key = websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(key, "l/RUfZOuwN8ZLGaqYec2qLKRXcs=");
    }

    #[test]
    fn test_upgrade_headers() {
        let headers = upgrade_response_headers("dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(headers.len(), 3);
        assert_eq!(headers[0].1, "websocket");
        assert_eq!(headers[1].1, "Upgrade");
        assert_eq!(headers[2].1, "l/RUfZOuwN8ZLGaqYec2qLKRXcs=");
    }
}

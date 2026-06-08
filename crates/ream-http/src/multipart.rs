//! `multipart/form-data` parsing — wire-level.
//!
//! Replaces the JS regex-based `parseMultipartFiles`. The HyperServer detects
//! multipart bodies, runs them through the `multer` crate (RFC 2046 / RFC
//! 7578 parser), and ships the structured result to JS via `request.multipart`.
//! JS no longer parses raw bytes — it consumes the typed payload.
//!
//! @implements FR21

use base64::Engine as _;
use bytes::Bytes;
use serde::{Deserialize, Serialize};

/// One non-file form field (`<input type="text" name="...">`). Repeated
/// names are surfaced as separate entries — the JS layer can collapse if
/// it wants array semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartField {
    pub name: String,
    pub value: String,
}

/// One uploaded file. Bytes are base64-encoded so the typed NAPI payload
/// stays JSON-safe; the JS `MultipartFile` decodes once into a `Buffer`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartFilePayload {
    pub field_name: String,
    pub client_name: String,
    pub content_type: String,
    pub size: u64,
    /// Base64-encoded file bytes.
    pub content_b64: String,
}

/// Pre-parsed `multipart/form-data` body. Set on `ReamRequest.multipart`
/// when the server identifies the content-type and successfully parses the
/// payload.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPayload {
    pub fields: Vec<MultipartField>,
    pub files: Vec<MultipartFilePayload>,
}

/// Parse a `multipart/form-data` body. The boundary is extracted from the
/// `Content-Type` header by the caller. Returns `Err` if the body is
/// malformed; the server then surfaces a 400.
pub async fn parse_multipart(boundary: &str, body: Bytes) -> Result<MultipartPayload, multer::Error> {
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use futures_core::Stream;

    // multer expects a Stream<Item = Result<Bytes, _>>. We hand it the whole
    // body as one chunk — Rust collected everything in `hyper_to_ream_request`
    // before we got here, so streaming chunks would be a no-op. Hand-roll a
    // minimal `Stream` adapter to avoid pulling in all of `futures-util`.
    struct OnceStream(Option<Bytes>);
    impl Stream for OnceStream {
        type Item = Result<Bytes, multer::Error>;
        fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            Poll::Ready(self.0.take().map(Ok))
        }
    }

    let body_stream = OnceStream(Some(body));
    let mut multipart = multer::Multipart::new(body_stream, boundary);

    let mut payload = MultipartPayload::default();

    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        let file_name = field.file_name().map(|s| s.to_string());
        let content_type = field.content_type().map(|m| m.to_string()).unwrap_or_default();

        // `bytes()` consumes the field — we drop the `Field` after.
        let bytes = field.bytes().await?;

        match file_name {
            Some(file_name) if !file_name.is_empty() => {
                let size = bytes.len() as u64;
                let content_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                payload.files.push(MultipartFilePayload {
                    field_name: name,
                    client_name: file_name,
                    content_type: if content_type.is_empty() {
                        "application/octet-stream".to_string()
                    } else {
                        content_type
                    },
                    size,
                    content_b64,
                });
            }
            _ => {
                // Plain field — interpret bytes as UTF-8 (lossy for invalid
                // sequences; matches what browsers send for `<input>` text).
                let value = String::from_utf8_lossy(&bytes).into_owned();
                payload.fields.push(MultipartField { name, value });
            }
        }
    }

    Ok(payload)
}

/// Pull `boundary=...` out of a `Content-Type` header value.
pub fn extract_boundary(content_type: &str) -> Option<String> {
    for part in content_type.split(';') {
        let trimmed = part.trim();
        if let Some(rest) = trimmed.strip_prefix("boundary=") {
            // Strip surrounding quotes if present (`boundary="abc"`)
            let unquoted = rest.trim_matches('"');
            if !unquoted.is_empty() {
                return Some(unquoted.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_with_text_field(boundary: &str, name: &str, value: &str) -> Bytes {
        let body = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"{name}\"\r\n\
             \r\n\
             {value}\r\n\
             --{boundary}--\r\n"
        );
        Bytes::from(body)
    }

    fn body_with_file(boundary: &str, name: &str, filename: &str, ct: &str, content: &[u8]) -> Bytes {
        let mut bytes = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n\
             Content-Type: {ct}\r\n\
             \r\n"
        ).into_bytes();
        bytes.extend_from_slice(content);
        bytes.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        Bytes::from(bytes)
    }

    #[test]
    fn boundary_extracted_unquoted() {
        assert_eq!(
            extract_boundary("multipart/form-data; boundary=----WebKitFormBoundary123"),
            Some("----WebKitFormBoundary123".into())
        );
    }

    #[test]
    fn boundary_extracted_quoted() {
        assert_eq!(
            extract_boundary(r#"multipart/form-data; boundary="abc""#),
            Some("abc".into())
        );
    }

    #[test]
    fn boundary_missing_returns_none() {
        assert!(extract_boundary("application/json").is_none());
    }

    #[tokio::test]
    async fn parses_a_single_text_field() {
        let body = body_with_text_field("BOUND", "title", "hello world");
        let payload = parse_multipart("BOUND", body).await.unwrap();
        assert_eq!(payload.fields.len(), 1);
        assert_eq!(payload.fields[0].name, "title");
        assert_eq!(payload.fields[0].value, "hello world");
        assert_eq!(payload.files.len(), 0);
    }

    #[tokio::test]
    async fn parses_a_single_file() {
        let body = body_with_file("BOUND", "avatar", "pic.png", "image/png", &[0x89, 0x50, 0x4e, 0x47]);
        let payload = parse_multipart("BOUND", body).await.unwrap();
        assert_eq!(payload.files.len(), 1);
        let file = &payload.files[0];
        assert_eq!(file.field_name, "avatar");
        assert_eq!(file.client_name, "pic.png");
        assert_eq!(file.content_type, "image/png");
        assert_eq!(file.size, 4);
        let bytes = base64::engine::general_purpose::STANDARD.decode(&file.content_b64).unwrap();
        assert_eq!(bytes, [0x89, 0x50, 0x4e, 0x47]);
    }

    #[tokio::test]
    async fn defaults_missing_content_type_for_files() {
        // No `Content-Type:` header on the part → defaults to octet-stream
        let mut bytes = b"--BOUND\r\n\
                          Content-Disposition: form-data; name=\"x\"; filename=\"f.bin\"\r\n\
                          \r\n".to_vec();
        bytes.extend_from_slice(&[1, 2, 3]);
        bytes.extend_from_slice(b"\r\n--BOUND--\r\n");
        let payload = parse_multipart("BOUND", Bytes::from(bytes)).await.unwrap();
        assert_eq!(payload.files[0].content_type, "application/octet-stream");
    }

    #[tokio::test]
    async fn malformed_body_surfaces_error() {
        // Boundary doesn't appear in the body — multer reports an error
        let body = Bytes::from("not a multipart body");
        assert!(parse_multipart("BOUND", body).await.is_err());
    }
}

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

/// Why a multipart body was not parsed.
#[derive(Debug)]
pub enum MultipartError {
    /// The body is not well-formed multipart; answered 400.
    Malformed(multer::Error),
    /// More fields than `max_fields`; the body is dropped as over its limit.
    TooManyFields,
    /// More files than `max_files`; the body is dropped as over its limit.
    TooManyFiles,
}

impl From<multer::Error> for MultipartError {
    fn from(error: multer::Error) -> Self {
        Self::Malformed(error)
    }
}

/// Parse a `multipart/form-data` body. The boundary is extracted from the
/// `Content-Type` header by the caller. The part counts are enforced as the
/// parts arrive: the parse stops at the first field or file past its bound,
/// before that part is read, so a body of hundreds of thousands of empty
/// parts costs no more than the first `max + 1` of them.
pub async fn parse_multipart(
    boundary: &str,
    body: Bytes,
    counts: crate::limits::MultipartCounts,
) -> Result<MultipartPayload, MultipartError> {
    use futures_core::Stream;
    use std::pin::Pin;
    use std::task::{Context, Poll};

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
        let content_type = field
            .content_type()
            .map(|m| m.to_string())
            .unwrap_or_default();

        let is_file = file_name.as_deref().is_some_and(|name| !name.is_empty());
        if is_file && payload.files.len() >= counts.max_files {
            return Err(MultipartError::TooManyFiles);
        }
        if !is_file && payload.fields.len() >= counts.max_fields {
            return Err(MultipartError::TooManyFields);
        }

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
        // Parameter names are case-insensitive (RFC 9110 §5.6.6).
        let rest = match (trimmed.get(..9), trimmed.get(9..)) {
            (Some(name), Some(rest)) if name.eq_ignore_ascii_case("boundary=") => Some(rest),
            _ => None,
        };
        if let Some(rest) = rest {
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
    use crate::limits::MultipartCounts;

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

    fn body_with_file(
        boundary: &str,
        name: &str,
        filename: &str,
        ct: &str,
        content: &[u8],
    ) -> Bytes {
        let mut bytes = format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n\
             Content-Type: {ct}\r\n\
             \r\n"
        )
        .into_bytes();
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
        let payload = parse_multipart("BOUND", body, MultipartCounts::default())
            .await
            .unwrap();
        assert_eq!(payload.fields.len(), 1);
        assert_eq!(payload.fields[0].name, "title");
        assert_eq!(payload.fields[0].value, "hello world");
        assert_eq!(payload.files.len(), 0);
    }

    #[tokio::test]
    async fn parses_a_single_file() {
        let body = body_with_file(
            "BOUND",
            "avatar",
            "pic.png",
            "image/png",
            &[0x89, 0x50, 0x4e, 0x47],
        );
        let payload = parse_multipart("BOUND", body, MultipartCounts::default())
            .await
            .unwrap();
        assert_eq!(payload.files.len(), 1);
        let file = &payload.files[0];
        assert_eq!(file.field_name, "avatar");
        assert_eq!(file.client_name, "pic.png");
        assert_eq!(file.content_type, "image/png");
        assert_eq!(file.size, 4);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.content_b64)
            .unwrap();
        assert_eq!(bytes, [0x89, 0x50, 0x4e, 0x47]);
    }

    #[tokio::test]
    async fn defaults_missing_content_type_for_files() {
        // No `Content-Type:` header on the part → defaults to octet-stream
        let mut bytes = b"--BOUND\r\n\
                          Content-Disposition: form-data; name=\"x\"; filename=\"f.bin\"\r\n\
                          \r\n"
            .to_vec();
        bytes.extend_from_slice(&[1, 2, 3]);
        bytes.extend_from_slice(b"\r\n--BOUND--\r\n");
        let payload = parse_multipart("BOUND", Bytes::from(bytes), MultipartCounts::default())
            .await
            .unwrap();
        assert_eq!(payload.files[0].content_type, "application/octet-stream");
    }

    #[tokio::test]
    async fn malformed_body_surfaces_error() {
        // Boundary doesn't appear in the body — multer reports an error
        let body = Bytes::from("not a multipart body");
        assert!(parse_multipart("BOUND", body, MultipartCounts::default())
            .await
            .is_err());
    }

    /// `count` empty text fields, then `files` one-byte files.
    fn many_parts(fields: usize, files: usize) -> Bytes {
        let mut body = String::new();
        for i in 0..fields {
            body.push_str(&format!(
                "--B\r\nContent-Disposition: form-data; name=\"f{i}\"\r\n\r\n\r\n"
            ));
        }
        for i in 0..files {
            body.push_str(&format!(
                "--B\r\nContent-Disposition: form-data; name=\"u{i}\"; filename=\"u{i}.txt\"\r\n\r\nx\r\n"
            ));
        }
        body.push_str("--B--\r\n");
        Bytes::from(body)
    }

    fn counts(max_fields: usize, max_files: usize) -> MultipartCounts {
        MultipartCounts {
            max_fields,
            max_files,
        }
    }

    #[tokio::test]
    async fn stops_at_the_first_field_past_max_fields() {
        let result = parse_multipart("B", many_parts(350_000, 0), counts(1000, 1000)).await;
        assert!(matches!(result, Err(MultipartError::TooManyFields)));
    }

    #[tokio::test]
    async fn stops_at_the_first_file_past_max_files() {
        let result = parse_multipart("B", many_parts(0, 3), counts(1000, 2)).await;
        assert!(matches!(result, Err(MultipartError::TooManyFiles)));
    }

    #[tokio::test]
    async fn accepts_exactly_the_configured_counts() {
        let payload = parse_multipart("B", many_parts(2, 2), counts(2, 2))
            .await
            .unwrap();
        assert_eq!(payload.fields.len(), 2);
        assert_eq!(payload.files.len(), 2);
    }
}

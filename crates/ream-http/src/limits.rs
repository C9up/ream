//! Request-body size limits and connection limits of the native server.
//!
//! Body limits follow `@adonisjs/bodyparser`'s `defineConfig` defaults
//! (json / form / raw 1 MB, multipart 20 MB) and its content-type matching.
//! They are applied while the body is read: a declared `Content-Length` over
//! the limit is not read at all, and a streamed body stops being kept the
//! moment it goes past it. The request then reaches JS without its body,
//! marked `bodyTooLarge`, so routing answers first and the body parser
//! raises the 413.
//!
//! Connection limits follow what an Adonis app gets from Node's `http.Server`
//! (`headersTimeout` 60 s, `requestTimeout` 300 s, `keepAliveTimeout` 5 s),
//! plus a cap on concurrent connections.

use std::time::Duration;

const MB: u64 = 1024 * 1024;

/// The limit of one parser and the content types it claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyLimit {
    /// Maximum body size in bytes.
    pub limit: u64,
    /// Content types (`application/json`, `text/*`, `*/*`).
    pub types: Vec<String>,
}

impl BodyLimit {
    fn new(limit: u64, types: &[&str]) -> Self {
        Self {
            limit,
            types: types.iter().map(|t| t.to_string()).collect(),
        }
    }
}

/// Per-content-type body limits.
///
/// A body whose content type no parser claims — `application/octet-stream`,
/// or no content type at all — gets the `raw` limit, the same fallback the
/// TS body parser applies to its size check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyLimits {
    pub json: BodyLimit,
    pub form: BodyLimit,
    pub raw: BodyLimit,
    pub multipart: BodyLimit,
    /// How many fields and files a multipart body may carry.
    pub multipart_counts: MultipartCounts,
}

/// The part counts of a multipart body, enforced while it is parsed: the
/// parse stops at the first part past either bound, before reading it.
/// The body parser's `maxFields` and `maxFiles`, both 1000 by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MultipartCounts {
    pub max_fields: usize,
    pub max_files: usize,
}

impl Default for MultipartCounts {
    fn default() -> Self {
        Self {
            max_fields: 1000,
            max_files: 1000,
        }
    }
}

impl Default for BodyLimits {
    fn default() -> Self {
        Self {
            json: BodyLimit::new(
                MB,
                &[
                    "application/json",
                    "application/json-patch+json",
                    "application/vnd.api+json",
                    "application/csp-report",
                ],
            ),
            form: BodyLimit::new(MB, &["application/x-www-form-urlencoded"]),
            raw: BodyLimit::new(MB, &["text/*"]),
            multipart: BodyLimit::new(20 * MB, &["multipart/form-data"]),
            multipart_counts: MultipartCounts::default(),
        }
    }
}

impl BodyLimits {
    /// The limit for a request with this `Content-Type` header value.
    /// Checked in the body parser's order: json, form, multipart, then raw,
    /// which is also the fallback.
    pub fn limit_for(&self, content_type: &str) -> u64 {
        [&self.json, &self.form, &self.multipart]
            .into_iter()
            .find(|parser| matches_type(content_type, &parser.types))
            .unwrap_or(&self.raw)
            .limit
    }
}

/// Whether a `Content-Type` value matches one of `types`: exact media type,
/// `type/*` prefix, or `*/*`, ignoring parameters and case. The TS body
/// parser's `matchesType`.
fn matches_type(content_type: &str, types: &[String]) -> bool {
    let actual = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if actual.is_empty() {
        return false;
    }
    types.iter().any(|candidate| {
        let pattern = candidate.trim().to_ascii_lowercase();
        if pattern == "*/*" {
            return true;
        }
        match pattern.strip_suffix('*') {
            Some(prefix) if prefix.ends_with('/') => actual.starts_with(prefix),
            _ => actual == pattern,
        }
    })
}

/// Timeouts and the connection cap. `None` / `0` disables a bound, as `0`
/// does on Node's server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionLimits {
    /// Time allowed to receive a request's complete head, counted from the
    /// moment the server starts waiting for it (connection accepted, or the
    /// previous response written). Node's `headersTimeout`, default 60 s.
    pub headers_timeout: Option<Duration>,
    /// Time allowed to receive a request's complete body once its head has
    /// arrived; past it the server answers 408. Node's `requestTimeout`,
    /// default 300 s.
    pub request_timeout: Option<Duration>,
    /// Time an idle connection is kept open after its last response. Node's
    /// `keepAliveTimeout`, default 5 s.
    pub keep_alive_timeout: Option<Duration>,
    /// Maximum concurrent connections; further clients wait in the listen
    /// backlog until one closes. `0` = unbounded. Default 10 000.
    pub max_connections: usize,
}

impl Default for ConnectionLimits {
    fn default() -> Self {
        Self {
            headers_timeout: Some(Duration::from_secs(60)),
            request_timeout: Some(Duration::from_secs(300)),
            keep_alive_timeout: Some(Duration::from_secs(5)),
            max_connections: 10_000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_bodyparser_defaults() {
        let limits = BodyLimits::default();
        assert_eq!(limits.limit_for("application/json"), MB);
        assert_eq!(limits.limit_for("application/x-www-form-urlencoded"), MB);
        assert_eq!(limits.limit_for("text/plain"), MB);
        assert_eq!(limits.limit_for("multipart/form-data; boundary=x"), 20 * MB);
    }

    #[test]
    fn unclaimed_types_fall_back_to_the_raw_limit() {
        let mut limits = BodyLimits::default();
        limits.raw.limit = 7;
        assert_eq!(limits.limit_for("application/octet-stream"), 7);
        assert_eq!(limits.limit_for(""), 7);
    }

    #[test]
    fn matching_ignores_parameters_and_case() {
        let limits = BodyLimits {
            json: BodyLimit::new(11, &["application/json"]),
            ..BodyLimits::default()
        };
        assert_eq!(limits.limit_for("Application/JSON; charset=utf-8"), 11);
    }

    #[test]
    fn wildcards_match_a_whole_family() {
        let limits = BodyLimits {
            form: BodyLimit::new(3, &["application/*"]),
            ..BodyLimits::default()
        };
        assert_eq!(limits.limit_for("application/xml"), 3);
        assert_eq!(limits.limit_for("applicationx/xml"), MB);

        let limits = BodyLimits {
            json: BodyLimit::new(5, &["*/*"]),
            ..BodyLimits::default()
        };
        assert_eq!(limits.limit_for("image/png"), 5);
    }

    #[test]
    fn a_parser_with_no_types_claims_nothing() {
        let limits = BodyLimits {
            multipart: BodyLimit::new(50 * MB, &[]),
            ..BodyLimits::default()
        };
        assert_eq!(limits.limit_for("multipart/form-data; boundary=x"), MB);
    }
}

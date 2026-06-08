//! # ream-http
//!
//! Hyper HTTP server core for the Ream framework.
//!
//! Provides a high-performance HTTP server powered by Hyper (Rust)
//! that crosses NAPI to call TypeScript request handlers.
//!
//! @implements FR23

pub mod cookies;
pub mod ip;
pub mod multipart;
pub mod ratelimit;
pub mod request;
pub mod response;
pub mod security;
pub mod server;
pub mod stream_registry;
pub mod websocket;

pub use cookies::parse_cookie_header;
pub use ip::{ip_in_cidr, resolve_client_ip};
pub use multipart::{
    MultipartField, MultipartFilePayload, MultipartPayload, extract_boundary, parse_multipart,
};
pub use ratelimit::{RateLimitConfig, RateLimitOutcome, RateLimiter};
pub use request::ReamRequest;
pub use response::ReamResponse;
pub use security::{FilterResult, NoopFilter, SecurityFilter, ShieldConfig, ShieldFilter};
pub use server::{ReamServer, RequestHandler, ResponseBody, ResponseFilter};
pub use stream_registry::{StreamChunk, StreamId, StreamRegistry};

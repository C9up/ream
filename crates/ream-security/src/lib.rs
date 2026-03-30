//! # ream-security
//!
//! Blackhole security layer for the Ream framework.
//!
//! Provides Rust-side security filtering that runs before the NAPI boundary:
//! - XSS sanitization
//! - CSRF token validation
//! - Rate limiting
//!
//! Security is on by default — opt-out, not opt-in.
//!
//! @implements FR43, FR44, FR45, FR46, FR47

pub mod blackhole;
pub mod csrf;
pub mod rate_limit;
pub mod xss;

pub use blackhole::{BlackholeConfig, BlackholeFilter};
pub use csrf::CsrfValidator;
pub use rate_limit::RateLimiter;

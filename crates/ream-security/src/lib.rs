//! # ream-security
//!
//! Blackhole security layer + crypto utilities for the Ream framework.
//!
//! - XSS sanitization, CSRF tokens, rate limiting
//! - Argon2id password hashing (timing-safe)
//! - JWT HS256 signing/verification (Rust-native crypto)
//! - Constant-time comparison (anti timing attacks)
//!
//! @implements FR43, FR44, FR45, FR46, FR47, FR49, FR52, FR53

pub mod argon2_hash;
pub mod blackhole;
pub mod constant_time;
pub mod csrf;
pub mod jwt;
pub mod rate_limit;
pub mod xss;

pub use argon2_hash::{hash_password, verify_password};
pub use blackhole::{BlackholeConfig, BlackholeFilter};
pub use constant_time::{constant_time_eq, constant_time_str_eq};
pub use csrf::CsrfValidator;
pub use jwt::{sign as jwt_sign, verify as jwt_verify};
pub use rate_limit::RateLimiter;

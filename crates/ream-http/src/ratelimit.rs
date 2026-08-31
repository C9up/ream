//! Rate limiting — token-bucket-ish per-key counter with TTL eviction.
//!
//! Replaces the JS `RateLimitMiddleware`'s in-memory `Map`. The Rust limiter
//! lives behind the NAPI boundary so:
//!
//! 1. Counters are atomic — concurrent requests within one Tokio runtime
//!    share state without round-tripping through the V8 event loop.
//! 2. The block decision is made BEFORE NAPI dispatch, so rejected requests
//!    cost zero JS time.
//!
//! The implementation is intentionally simple — fixed window, in-process
//! storage. Distributed setups will plug a Redis-backed limiter into the
//! same `RateLimiter` trait surface in a later phase.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Rate-limit configuration. `max` requests per `window` seconds, keyed by
/// the value the server-side resolver produces (typically `request.ip`).
#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    pub max: u32,
    pub window: Duration,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max: 100,
            window: Duration::from_secs(60),
        }
    }
}

/// What the limiter decided about one request.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitOutcome {
    pub allowed: bool,
    pub limit: u32,
    pub remaining: u32,
    pub reset_in: Duration,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    count: u32,
    reset_at: Instant,
}

/// In-memory rate limiter. Thread-safe (`Mutex<HashMap>`), suitable for the
/// single-process Hyper server. Counters are reset lazily — buckets older
/// than the window are dropped on the next access for that key, and the
/// whole map is swept opportunistically when it grows past 1024 entries.
pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Register one request against `key`. Returns the outcome — the caller
    /// short-circuits with 429 when `allowed == false`, otherwise dispatches
    /// the request and attaches rate-limit headers to the response.
    pub fn check(&self, key: &str) -> RateLimitOutcome {
        let now = Instant::now();
        let mut buckets = match self.buckets.lock() {
            Ok(g) => g,
            // Mutex poisoned — fall through allow-all rather than refuse
            // every request. Better to ship a request than to brick the
            // server because of an unrelated panic in a peer thread.
            Err(_) => {
                return RateLimitOutcome {
                    allowed: true,
                    limit: self.config.max,
                    remaining: self.config.max,
                    reset_in: self.config.window,
                };
            }
        };

        // Opportunistic sweep so a long-running server doesn't accumulate
        // dead keys forever. Only fires when the map is already large.
        if buckets.len() > 1024 {
            buckets.retain(|_, b| b.reset_at > now);
        }

        let bucket = buckets.entry(key.to_string()).or_insert(Bucket {
            count: 0,
            reset_at: now + self.config.window,
        });

        // Window elapsed for this key — start fresh.
        if bucket.reset_at <= now {
            bucket.count = 0;
            bucket.reset_at = now + self.config.window;
        }

        bucket.count += 1;
        let count = bucket.count;
        let reset_at = bucket.reset_at;
        drop(buckets);

        // Block only AFTER the limit has been exceeded — `max=2` means two
        // successful requests then the third fails. Mirrors the prior JS
        // semantics (the off-by-one fix landed in the recovery sprint).
        let allowed = count <= self.config.max;
        let remaining = self.config.max.saturating_sub(count);
        let reset_in = reset_at.saturating_duration_since(now);

        RateLimitOutcome {
            allowed,
            limit: self.config.max,
            remaining,
            reset_in,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn allows_up_to_max_then_blocks() {
        let limiter = RateLimiter::new(RateLimitConfig {
            max: 2,
            window: Duration::from_secs(60),
        });
        assert!(limiter.check("ip1").allowed);
        assert!(limiter.check("ip1").allowed);
        let blocked = limiter.check("ip1");
        assert!(!blocked.allowed);
        assert_eq!(blocked.limit, 2);
        assert_eq!(blocked.remaining, 0);
    }

    #[test]
    fn isolates_keys() {
        let limiter = RateLimiter::new(RateLimitConfig {
            max: 1,
            window: Duration::from_secs(60),
        });
        assert!(limiter.check("ip1").allowed);
        // Different key → fresh bucket
        assert!(limiter.check("ip2").allowed);
        // Same key → blocked
        assert!(!limiter.check("ip1").allowed);
    }

    #[test]
    fn resets_after_window_elapses() {
        let limiter = RateLimiter::new(RateLimitConfig {
            max: 1,
            window: Duration::from_millis(50),
        });
        assert!(limiter.check("ip1").allowed);
        assert!(!limiter.check("ip1").allowed);
        sleep(Duration::from_millis(60));
        // Window elapsed — counter reset.
        assert!(limiter.check("ip1").allowed);
    }

    #[test]
    fn remaining_counts_down() {
        let limiter = RateLimiter::new(RateLimitConfig {
            max: 3,
            window: Duration::from_secs(60),
        });
        assert_eq!(limiter.check("ip1").remaining, 2);
        assert_eq!(limiter.check("ip1").remaining, 1);
        assert_eq!(limiter.check("ip1").remaining, 0);
        // Past the limit — still 0, not negative.
        assert_eq!(limiter.check("ip1").remaining, 0);
    }
}

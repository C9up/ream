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
//! storage, a bounded number of tracked keys. Distributed setups will plug a Redis-backed limiter into the
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

/// How many distinct keys the limiter tracks before new ones share a single
/// overflow bucket. Keys are client addresses, and one client holding an
/// IPv6 /64 has more of them than any map should hold.
const DEFAULT_MAX_KEYS: usize = 100_000;

/// The buckets, and when they are next swept for expired ones.
struct State {
    buckets: HashMap<String, Bucket>,
    overflow: Bucket,
    next_sweep: Instant,
}

/// In-memory rate limiter. Thread-safe (`Mutex<HashMap>`), suitable for the
/// single-process Hyper server. A bucket older than the window is reset on
/// the next access for its key; expired buckets are swept at most once per
/// window, so the O(n) pass is amortised over every request of a window
/// instead of paid by each one. The map is capped at `max_keys`: past it, a
/// key that is not tracked yet counts against one shared overflow bucket, so
/// rotating through fresh addresses neither grows the map nor escapes the
/// limit.
pub struct RateLimiter {
    config: RateLimitConfig,
    max_keys: usize,
    state: Mutex<State>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self::with_max_keys(config, DEFAULT_MAX_KEYS)
    }

    /// A limiter tracking at most `max_keys` distinct keys.
    pub fn with_max_keys(config: RateLimitConfig, max_keys: usize) -> Self {
        let now = Instant::now();
        Self {
            config,
            max_keys,
            state: Mutex::new(State {
                buckets: HashMap::new(),
                overflow: Bucket {
                    count: 0,
                    reset_at: now + config.window,
                },
                next_sweep: now + config.window,
            }),
        }
    }

    /// Register one request against `key`. Returns the outcome — the caller
    /// short-circuits with 429 when `allowed == false`, otherwise dispatches
    /// the request and attaches rate-limit headers to the response.
    pub fn check(&self, key: &str) -> RateLimitOutcome {
        let now = Instant::now();
        let mut state = match self.state.lock() {
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
        let state = &mut *state;

        if now >= state.next_sweep {
            state.buckets.retain(|_, b| b.reset_at > now);
            state.next_sweep = now + self.config.window;
        }

        let bucket = if state.buckets.contains_key(key) || state.buckets.len() < self.max_keys {
            state.buckets.entry(key.to_string()).or_insert(Bucket {
                count: 0,
                reset_at: now + self.config.window,
            })
        } else {
            &mut state.overflow
        };

        // Window elapsed for this key — start fresh.
        if bucket.reset_at <= now {
            bucket.count = 0;
            bucket.reset_at = now + self.config.window;
        }

        bucket.count = bucket.count.saturating_add(1);
        let count = bucket.count;
        let reset_at = bucket.reset_at;

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
impl RateLimiter {
    /// How many keys hold their own bucket.
    fn tracked(&self) -> usize {
        self.state.lock().map_or(0, |state| state.buckets.len())
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
    fn keys_past_the_cap_share_one_overflow_bucket() {
        let limiter = RateLimiter::with_max_keys(
            RateLimitConfig {
                max: 1,
                window: Duration::from_secs(60),
            },
            2,
        );
        assert!(limiter.check("ip1").allowed);
        assert!(limiter.check("ip2").allowed);
        // The map is full: a fresh address is counted in the shared bucket,
        // so rotating addresses does not escape the limit.
        assert!(limiter.check("ip3").allowed);
        assert!(!limiter.check("ip4").allowed);
        assert!(!limiter.check("ip5").allowed);
        assert_eq!(limiter.tracked(), 2);
        // A key already tracked keeps its own bucket.
        assert!(!limiter.check("ip1").allowed);
    }

    #[test]
    fn expired_keys_are_swept_once_the_window_has_passed() {
        let limiter = RateLimiter::with_max_keys(
            RateLimitConfig {
                max: 1,
                window: Duration::from_millis(50),
            },
            2,
        );
        assert!(limiter.check("ip1").allowed);
        assert!(limiter.check("ip2").allowed);
        sleep(Duration::from_millis(60));
        // The sweep frees both slots, so a new address gets its own bucket
        // again rather than the overflow one.
        assert!(limiter.check("ip3").allowed);
        assert_eq!(limiter.tracked(), 1);
        assert!(limiter.check("ip4").allowed);
        assert_eq!(limiter.tracked(), 2);
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

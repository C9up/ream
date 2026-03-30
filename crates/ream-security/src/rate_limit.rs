//! Rate limiting implementation.
//!
//! @implements FR46

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Simple in-memory rate limiter.
///
/// Tracks requests per key (typically client IP) within a time window.
pub struct RateLimiter {
    /// Maximum requests per window
    max_requests: u32,
    /// Time window duration
    window: Duration,
    /// Request counts per key: (count, window_start)
    counters: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    /// Create a new rate limiter.
    ///
    /// # Arguments
    /// * `max_requests` - Maximum requests allowed per window
    /// * `window_secs` - Window duration in seconds
    pub fn new(max_requests: u32, window_secs: u64) -> Self {
        Self {
            max_requests,
            window: Duration::from_secs(window_secs),
            counters: Mutex::new(HashMap::new()),
        }
    }

    /// Check if a request from the given key is allowed.
    /// Returns `true` if allowed, `false` if rate limited.
    pub fn check(&self, key: &str) -> bool {
        let mut counters = self.counters.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();

        // Evict expired entries periodically to prevent unbounded growth
        // Run eviction every 100 checks (amortized cost)
        let total: usize = counters.values().map(|(c, _)| *c as usize).sum();
        if total % 100 == 0 {
            let window = self.window;
            counters.retain(|_, (_, start)| now.duration_since(*start) <= window);
        }

        let entry = counters.entry(key.to_string()).or_insert((0, now));

        // Reset window if expired
        if now.duration_since(entry.1) > self.window {
            *entry = (0, now);
        }

        entry.0 += 1;
        entry.0 <= self.max_requests
    }

    /// Get remaining requests for a key.
    pub fn remaining(&self, key: &str) -> u32 {
        let counters = self.counters.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();

        match counters.get(key) {
            Some((count, start)) => {
                if now.duration_since(*start) > self.window {
                    self.max_requests
                } else {
                    self.max_requests.saturating_sub(*count)
                }
            }
            None => self.max_requests,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limiter_allows_within_limit() {
        let limiter = RateLimiter::new(3, 60);
        assert!(limiter.check("ip1"));
        assert!(limiter.check("ip1"));
        assert!(limiter.check("ip1"));
    }

    #[test]
    fn test_rate_limiter_blocks_over_limit() {
        let limiter = RateLimiter::new(2, 60);
        assert!(limiter.check("ip1"));
        assert!(limiter.check("ip1"));
        assert!(!limiter.check("ip1"));
    }

    #[test]
    fn test_rate_limiter_separate_keys() {
        let limiter = RateLimiter::new(1, 60);
        assert!(limiter.check("ip1"));
        assert!(limiter.check("ip2")); // Different key
        assert!(!limiter.check("ip1")); // Same key, over limit
    }

    #[test]
    fn test_remaining() {
        let limiter = RateLimiter::new(5, 60);
        assert_eq!(limiter.remaining("ip1"), 5);
        limiter.check("ip1");
        limiter.check("ip1");
        assert_eq!(limiter.remaining("ip1"), 3);
    }
}

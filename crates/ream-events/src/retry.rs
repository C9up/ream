//! Retry with exponential backoff and dead letter queue.
//!
//! @implements FR5, FR6

use crate::event::Event;
use crate::store::{EventStatus, EventStore};
use std::panic::{self, AssertUnwindSafe};
use std::sync::Arc;
use std::time::Duration;

/// Configuration for retry behavior on a handler.
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Maximum number of retry attempts (default: 3).
    pub max_retries: u8,
    /// Base delay for exponential backoff in milliseconds (default: 100).
    pub base_delay_ms: u64,
    /// Maximum delay cap in milliseconds (default: 30000).
    pub max_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 100,
            max_delay_ms: 30_000,
        }
    }
}

impl RetryConfig {
    /// Calculate delay for a given attempt using exponential backoff.
    /// delay = min(base_delay * 2^attempt, max_delay)
    pub fn delay_for_attempt(&self, attempt: u8) -> Duration {
        let shift = (attempt as u32).min(63);
        let multiplier = 1u64.checked_shl(shift).unwrap_or(u64::MAX);
        let delay = self.base_delay_ms.saturating_mul(multiplier);
        Duration::from_millis(delay.min(self.max_delay_ms))
    }
}

/// Handler that can fail — returns Result<(), String>.
pub type FallibleHandler = Arc<dyn Fn(Event) -> Result<(), String> + Send + Sync>;

/// Execute a handler with retry logic.
/// Catches panics. On final failure, stores as Failed and returns the error.
///
/// Returns Ok(()) if the handler eventually succeeds, Err(error_msg) if all retries exhausted.
pub async fn execute_with_retry(
    handler: &FallibleHandler,
    event: &Event,
    config: &RetryConfig,
    store: Option<&Arc<dyn EventStore>>,
) -> Result<(), String> {
    let mut last_error = String::new();

    for attempt in 0..=config.max_retries {
        // Update status to Processing (first attempt) or Retrying
        if let Some(store) = store {
            if attempt == 0 {
                let _ = store.ack(&event.id, EventStatus::Processing);
            } else {
                let _ = store.ack(&event.id, EventStatus::Retrying { attempt });
            }
        }

        // Call handler with panic catch
        let handler_clone = handler.clone();
        let event_clone = event.clone();
        let result = panic::catch_unwind(AssertUnwindSafe(move || handler_clone(event_clone)));

        match result {
            Ok(Ok(())) => {
                if let Some(store) = store {
                    let _ = store.ack(&event.id, EventStatus::Success);
                }
                return Ok(());
            }
            Ok(Err(err)) => {
                last_error = err;
            }
            Err(_) => {
                last_error = "handler panicked".to_string();
            }
        }

        if attempt < config.max_retries {
            let delay = config.delay_for_attempt(attempt);
            tokio::time::sleep(delay).await;
        }
    }

    // All retries exhausted — mark as failed (dead letter queue)
    if let Some(store) = store {
        let _ = store.ack(
            &event.id,
            EventStatus::Failed {
                error: last_error.clone(),
                severity: "error".to_string(),
            },
        );
    }

    Err(last_error)
}

/// Create a service.error event from a failed event.
pub fn create_error_event(
    original_event: &Event,
    error: &str,
    severity: &str,
) -> Event {
    let error_data = serde_json::json!({
        "source": original_event.name,
        "originalEventId": original_event.id,
        "error": error,
        "severity": severity,
    });

    let mut error_event = Event::new("service.error", &error_data.to_string());
    error_event.correlation_id = original_event.correlation_id.clone();
    error_event.causation_id = Some(original_event.id.clone());
    error_event
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use std::sync::atomic::{AtomicU8, Ordering};

    #[test]
    fn test_retry_config_delay() {
        let config = RetryConfig {
            max_retries: 3,
            base_delay_ms: 100,
            max_delay_ms: 5000,
        };
        assert_eq!(config.delay_for_attempt(0), Duration::from_millis(100));
        assert_eq!(config.delay_for_attempt(1), Duration::from_millis(200));
        assert_eq!(config.delay_for_attempt(2), Duration::from_millis(400));
        assert_eq!(config.delay_for_attempt(3), Duration::from_millis(800));
        // Capped at max
        assert_eq!(config.delay_for_attempt(10), Duration::from_millis(5000));
    }

    #[test]
    fn test_retry_config_delay_no_overflow() {
        let config = RetryConfig { max_retries: 255, base_delay_ms: 100, max_delay_ms: 30_000 };
        // Should not panic even with high attempt values
        let delay = config.delay_for_attempt(64);
        assert_eq!(delay, Duration::from_millis(30_000)); // capped
        let delay = config.delay_for_attempt(255);
        assert_eq!(delay, Duration::from_millis(30_000)); // capped
    }

    #[tokio::test]
    async fn test_execute_with_retry_success_first_try() {
        let handler: FallibleHandler = Arc::new(|_| Ok(()));
        let event = Event::new("test", "{}");
        let config = RetryConfig::default();
        let store = Arc::new(MemoryStore::new());
        store.push(event.clone(), 3).unwrap();

        let result = execute_with_retry(&handler, &event, &config, Some(&(store.clone() as Arc<dyn EventStore>))).await;
        assert!(result.is_ok());

        let tracked = store.get(&event.id).unwrap();
        assert_eq!(tracked.status, EventStatus::Success);
    }

    #[tokio::test]
    async fn test_execute_with_retry_success_after_retries() {
        let attempt_count = Arc::new(AtomicU8::new(0));
        let ac = attempt_count.clone();

        let handler: FallibleHandler = Arc::new(move |_| {
            let count = ac.fetch_add(1, Ordering::Relaxed);
            if count < 2 {
                Err("transient failure".to_string())
            } else {
                Ok(())
            }
        });

        let event = Event::new("test", "{}");
        let config = RetryConfig { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10 };
        let store = Arc::new(MemoryStore::new());
        store.push(event.clone(), 3).unwrap();

        let result = execute_with_retry(&handler, &event, &config, Some(&(store.clone() as Arc<dyn EventStore>))).await;
        assert!(result.is_ok());
        assert_eq!(attempt_count.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn test_execute_with_retry_all_failed_dead_letter() {
        let handler: FallibleHandler = Arc::new(|_| Err("permanent failure".to_string()));

        let event = Event::new("test", "{}");
        let config = RetryConfig { max_retries: 2, base_delay_ms: 1, max_delay_ms: 10 };
        let store = Arc::new(MemoryStore::new());
        store.push(event.clone(), 2).unwrap();

        let result = execute_with_retry(&handler, &event, &config, Some(&(store.clone() as Arc<dyn EventStore>))).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "permanent failure");

        let tracked = store.get(&event.id).unwrap();
        assert!(matches!(tracked.status, EventStatus::Failed { .. }));
        let failed = store.get_failed();
        assert_eq!(failed.len(), 1);
    }

    #[tokio::test]
    async fn test_execute_without_store() {
        let handler: FallibleHandler = Arc::new(|_| Ok(()));
        let event = Event::new("test", "{}");
        let config = RetryConfig::default();

        let result = execute_with_retry(&handler, &event, &config, None).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_execute_catches_panic() {
        let handler: FallibleHandler = Arc::new(|_| panic!("boom"));
        let event = Event::new("test", "{}");
        let config = RetryConfig { max_retries: 0, base_delay_ms: 1, max_delay_ms: 10 };
        let store = Arc::new(MemoryStore::new());
        store.push(event.clone(), 0).unwrap();

        let result = execute_with_retry(&handler, &event, &config, Some(&(store.clone() as Arc<dyn EventStore>))).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "handler panicked");

        let tracked = store.get(&event.id).unwrap();
        assert!(matches!(tracked.status, EventStatus::Failed { .. }));
    }

    #[tokio::test]
    async fn test_execute_zero_retries() {
        let handler: FallibleHandler = Arc::new(|_| Err("fail".to_string()));
        let event = Event::new("test", "{}");
        let config = RetryConfig { max_retries: 0, base_delay_ms: 1, max_delay_ms: 10 };

        let result = execute_with_retry(&handler, &event, &config, None).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_create_error_event() {
        let original = Event::new("order.process", r#"{"orderId":"123"}"#);
        let error_event = create_error_event(&original, "DB connection lost", "error");

        assert_eq!(error_event.name, "service.error");
        assert_eq!(error_event.correlation_id, original.correlation_id);
        assert_eq!(error_event.causation_id, Some(original.id.clone()));
        assert!(error_event.data.contains("DB connection lost"));
        assert!(error_event.data.contains("order.process"));
        // correlationId should NOT be in payload (it's on the struct)
        assert!(!error_event.data.contains("correlationId"));
    }
}

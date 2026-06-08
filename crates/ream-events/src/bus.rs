//! event bus — the main entry point for event operations.
//!
//! @implements FR1, FR2, FR3, FR4, FR5, FR6

use crate::event::Event;
use crate::retry::{self, FallibleHandler, RetryConfig};
use crate::router::{EventHandler, EventRouter, SubscriptionId};
use crate::store::EventStore;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};

/// Request handler — receives event, returns response data string.
pub type RequestHandler = Arc<dyn Fn(Event) -> String + Send + Sync>;

/// Default max retries for events stored via the event store.
const DEFAULT_MAX_RETRIES: u8 = 3;
const DEFAULT_MAX_RETRY_CONCURRENCY: usize = 1024;

/// The event bus.
///
/// Each instance is independent (not a singleton) to support test isolation (NFR30-31).
pub struct Bus {
    router: Arc<EventRouter>,
    request_handlers: Arc<Mutex<HashMap<String, RequestHandler>>>,
    store: Option<Arc<dyn EventStore>>,
    retry_semaphore: Arc<Semaphore>,
}

impl Bus {
    /// Create a new Bus instance (without event store).
    pub fn new() -> Self {
        Self {
            router: Arc::new(EventRouter::new()),
            request_handlers: Arc::new(Mutex::new(HashMap::new())),
            store: None,
            retry_semaphore: Arc::new(Semaphore::new(DEFAULT_MAX_RETRY_CONCURRENCY)),
        }
    }

    /// Create a new Bus instance with an event store for persistence/tracking.
    pub fn with_store(store: Arc<dyn EventStore>) -> Self {
        Self {
            router: Arc::new(EventRouter::new()),
            request_handlers: Arc::new(Mutex::new(HashMap::new())),
            store: Some(store),
            retry_semaphore: Arc::new(Semaphore::new(DEFAULT_MAX_RETRY_CONCURRENCY)),
        }
    }

    /// Get a reference to the event store (if configured).
    pub fn store(&self) -> Option<&Arc<dyn EventStore>> {
        self.store.as_ref()
    }

    /// Emit an event to all matching subscribers (fire & forget).
    /// If an event store is configured, the event is persisted before dispatch.
    pub async fn emit(&self, name: &str, data: &str) -> Event {
        let event = Event::new(name, data);
        // Persist to store if configured
        if let Some(ref store) = self.store {
            if let Err(e) = store.push(event.clone(), DEFAULT_MAX_RETRIES) {
                eprintln!("[events] store push failed for '{}': {}", event.name, e);
            }
        }
        self.router.dispatch(&event).await;
        event
    }

    /// Emit an existing event object.
    pub async fn emit_event(&self, event: &Event) -> usize {
        if let Some(ref store) = self.store {
            if let Err(e) = store.push(event.clone(), DEFAULT_MAX_RETRIES) {
                eprintln!("[events] store push failed for '{}': {}", event.name, e);
            }
        }
        self.router.dispatch(event).await
    }

    /// Subscribe to events matching a pattern.
    pub async fn subscribe(&self, pattern: &str, handler: EventHandler) -> SubscriptionId {
        self.router.subscribe(pattern, handler).await
    }

    /// Unsubscribe by subscription ID.
    pub async fn unsubscribe(&self, sub_id: SubscriptionId) {
        self.router.unsubscribe(sub_id).await;
    }

    /// Register a request handler for a specific event name.
    /// Only one handler per event name (last one wins).
    pub async fn on_request(&self, name: &str, handler: RequestHandler) {
        let mut handlers = self.request_handlers.lock().await;
        handlers.insert(name.to_string(), handler);
    }

    /// Send a request and await a response (with timeout).
    ///
    /// Returns the response data string, or an error on timeout/no handler.
    pub async fn request(&self, name: &str, data: &str, timeout_ms: u64) -> Result<String, String> {
        let handlers = self.request_handlers.lock().await;
        let handler = handlers.get(name).cloned()
            .ok_or_else(|| format!("No request handler for '{}'", name))?;
        drop(handlers); // Release lock before calling handler

        let event = Event::new(name, data);

        // Use tokio timeout
        let result = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            tokio::task::spawn_blocking(move || handler(event)),
        ).await;

        match result {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(e)) => Err(format!("Handler panicked: {:?}", e)),
            Err(_) => Err(format!("Request '{}' timed out after {}ms", name, timeout_ms)),
        }
    }

    /// Subscribe with automatic retry and error event emission.
    ///
    /// When the handler fails:
    /// 1. Retries with exponential backoff (configurable)
    /// 2. Updates event status in the store (Retrying → Failed)
    /// 3. On final failure: emits a `service.error` event and moves to dead letter queue
    ///
    /// @implements FR5, FR6
    pub async fn subscribe_with_retry(
        &self,
        pattern: &str,
        handler: FallibleHandler,
        config: RetryConfig,
    ) -> SubscriptionId {
        let store = self.store.clone();
        let router = self.router.clone();
        let config = Arc::new(config);
        let retry_semaphore = self.retry_semaphore.clone();

        // Wrap the fallible handler in a fire-and-forget handler
        // that spawns retry logic as a tokio task
        let wrapper: EventHandler = Arc::new(move |event: Event| {
            let handler = handler.clone();
            let config = config.clone();
            let store = store.clone();
            let router = router.clone();
            let retry_semaphore = retry_semaphore.clone();

            tokio::spawn(async move {
                let permit = match retry_semaphore.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        eprintln!("[events] retry semaphore closed, dropping event '{}'", event.name);
                        return;
                    }
                };

                let _permit = permit;
                let result = retry::execute_with_retry(
                    &handler,
                    &event,
                    &config,
                    store.as_ref(),
                ).await;

                // On final failure: persist and emit service.error event
                if let Err(ref error_msg) = result {
                    let error_event = retry::create_error_event(&event, error_msg, "error");
                    if let Some(ref store) = store {
                        if let Err(e) = store.push(error_event.clone(), 0) {
                            eprintln!("[events] store push failed for '{}': {}", error_event.name, e);
                        }
                        if let Err(e) = store.ack(&error_event.id, crate::store::EventStatus::Success) {
                            eprintln!("[events] store ack failed for '{}': {}", error_event.id, e);
                        }
                    }
                    router.dispatch(&error_event).await;
                }
            });
        });

        self.router.subscribe(pattern, wrapper).await
    }

    /// Get subscription count.
    pub async fn subscription_count(&self) -> usize {
        self.router.subscription_count().await
    }
}

impl Default for Bus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{EventStatus, MemoryStore};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn test_bus_emit_and_subscribe() {
        let bus = Bus::new();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();

        bus.subscribe("order.created", Arc::new(move |event| {
            assert_eq!(event.name, "order.created");
            c.fetch_add(1, Ordering::Relaxed);
        })).await;

        let event = bus.emit("order.created", r#"{"orderId":"123"}"#).await;
        assert_eq!(event.name, "order.created");
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_bus_multiple_instances_independent() {
        let bus1 = Bus::new();
        let bus2 = Bus::new();

        let count1 = Arc::new(AtomicUsize::new(0));
        let count2 = Arc::new(AtomicUsize::new(0));

        let c1 = count1.clone();
        bus1.subscribe("test", Arc::new(move |_| { c1.fetch_add(1, Ordering::Relaxed); })).await;

        let c2 = count2.clone();
        bus2.subscribe("test", Arc::new(move |_| { c2.fetch_add(1, Ordering::Relaxed); })).await;

        bus1.emit("test", "{}").await;

        // Only bus1's subscriber should fire
        assert_eq!(count1.load(Ordering::Relaxed), 1);
        assert_eq!(count2.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn test_bus_emit_returns_event_with_ids() {
        let bus = Bus::new();
        let event = bus.emit("test.event", r#"{"key":"value"}"#).await;

        assert!(!event.id.is_empty());
        assert_eq!(event.correlation_id, event.id);
        assert!(event.causation_id.is_none());
        assert_eq!(event.name, "test.event");
    }

    #[tokio::test]
    async fn test_bus_request_reply() {
        let bus = Bus::new();
        bus.on_request("order.validate", Arc::new(|event| {
            let data: serde_json::Value = serde_json::from_str(&event.data).unwrap();
            if data["amount"].as_f64().unwrap_or(0.0) > 0.0 {
                r#"{"valid":true}"#.to_string()
            } else {
                r#"{"valid":false,"error":"Amount must be positive"}"#.to_string()
            }
        })).await;

        let response = bus.request("order.validate", r#"{"amount":42.50}"#, 5000).await;
        assert!(response.is_ok());
        let data: serde_json::Value = serde_json::from_str(&response.unwrap()).unwrap();
        assert_eq!(data["valid"], true);
    }

    #[tokio::test]
    async fn test_bus_request_no_handler() {
        let bus = Bus::new();
        let result = bus.request("nonexistent", "{}", 1000).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No request handler"));
    }

    #[tokio::test]
    async fn test_bus_request_timeout() {
        let bus = Bus::new();
        bus.on_request("slow", Arc::new(|_| {
            std::thread::sleep(std::time::Duration::from_millis(500));
            "response".to_string()
        })).await;

        let result = bus.request("slow", "{}", 50).await; // 50ms timeout
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("timed out"));
    }

    #[tokio::test]
    async fn test_bus_wildcard_subscribe() {
        let bus = Bus::new();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let e = events.clone();

        bus.subscribe("order.*", Arc::new(move |event| {
            e.lock().unwrap().push(event.name.clone());
        })).await;

        bus.emit("order.created", "{}").await;
        bus.emit("order.paid", "{}").await;
        bus.emit("payment.received", "{}").await; // Should not match

        let received = events.lock().unwrap();
        assert_eq!(received.len(), 2);
        assert!(received.contains(&"order.created".to_string()));
        assert!(received.contains(&"order.paid".to_string()));
    }

    #[tokio::test]
    async fn test_bus_with_store_persists_events() {
        let store = Arc::new(MemoryStore::new());
        let bus = Bus::with_store(store.clone());

        let event = bus.emit("order.created", r#"{"orderId":"1"}"#).await;
        assert_eq!(store.count(), 1);

        let tracked = store.get(&event.id).unwrap();
        assert_eq!(tracked.event.name, "order.created");
        assert_eq!(tracked.status, EventStatus::Pending);
        assert_eq!(tracked.max_retries, DEFAULT_MAX_RETRIES);
    }

    #[tokio::test]
    async fn test_bus_without_store_works() {
        let bus = Bus::new();
        assert!(bus.store().is_none());
        // emit still works without store
        let event = bus.emit("test", "{}").await;
        assert_eq!(event.name, "test");
    }

    #[tokio::test]
    async fn test_bus_emit_event_persists_to_store() {
        let store = Arc::new(MemoryStore::new());
        let bus = Bus::with_store(store.clone());

        let event = Event::new("order.paid", "{}");
        let id = event.id.clone();
        bus.emit_event(&event).await;

        assert_eq!(store.count(), 1);
        let tracked = store.get(&id).unwrap();
        assert_eq!(tracked.event.name, "order.paid");
    }

    #[tokio::test]
    async fn test_bus_store_ack_after_processing() {
        let store = Arc::new(MemoryStore::new());
        let bus = Bus::with_store(store.clone());

        let event = bus.emit("order.created", "{}").await;

        // Simulate successful processing
        store.ack(&event.id, EventStatus::Success).unwrap();
        let tracked = store.get(&event.id).unwrap();
        assert_eq!(tracked.status, EventStatus::Success);
    }

    #[tokio::test]
    async fn test_subscribe_with_retry_success() {
        let store = Arc::new(MemoryStore::new());
        let bus = Bus::with_store(store.clone());
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();

        bus.subscribe_with_retry(
            "order.created",
            Arc::new(move |_| { c.fetch_add(1, Ordering::Relaxed); Ok(()) }),
            RetryConfig { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10 },
        ).await;

        bus.emit("order.created", "{}").await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_subscribe_with_retry_retries_then_succeeds() {
        let store = Arc::new(MemoryStore::new());
        let bus = Bus::with_store(store.clone());
        let attempt = Arc::new(AtomicUsize::new(0));
        let a = attempt.clone();

        bus.subscribe_with_retry(
            "order.process",
            Arc::new(move |_| {
                let n = a.fetch_add(1, Ordering::Relaxed);
                if n < 2 { Err("transient".to_string()) } else { Ok(()) }
            }),
            RetryConfig { max_retries: 3, base_delay_ms: 1, max_delay_ms: 10 },
        ).await;

        bus.emit("order.process", "{}").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(attempt.load(Ordering::Relaxed), 3); // 2 failures + 1 success
    }

    #[tokio::test]
    async fn test_subscribe_with_retry_emits_service_error_on_failure() {
        let store = Arc::new(MemoryStore::new());
        let bus = Bus::with_store(store.clone());

        // Handler that always fails
        bus.subscribe_with_retry(
            "order.fail",
            Arc::new(|_| Err("permanent failure".to_string())),
            RetryConfig { max_retries: 1, base_delay_ms: 1, max_delay_ms: 10 },
        ).await;

        // Capture service.error events
        let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        let e = errors.clone();
        bus.subscribe("service.error", Arc::new(move |event| {
            e.lock().unwrap().push(event);
        })).await;

        bus.emit("order.fail", "{}").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let captured = errors.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].name, "service.error");
        assert!(captured[0].data.contains("permanent failure"));
        assert!(captured[0].data.contains("order.fail"));

        // Should be in dead letter queue
        let failed = store.get_failed();
        assert_eq!(failed.len(), 1);
    }
}

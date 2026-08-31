//! Event routing with exact match and wildcard pattern support.
//!
//! @implements FR1, FR2

use crate::event::Event;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Subscription ID for unsubscribe operations.
pub type SubscriptionId = u64;

/// Handler function called when an event matches.
pub type EventHandler = Arc<dyn Fn(Event) + Send + Sync>;

/// Event router — manages subscriptions and dispatches events.
pub struct EventRouter {
    /// Exact match subscriptions: event_name → [(sub_id, handler)]
    exact: RwLock<HashMap<String, Vec<(SubscriptionId, EventHandler)>>>,
    /// Wildcard subscriptions: pattern → [(sub_id, handler)]
    wildcards: RwLock<Vec<(String, SubscriptionId, EventHandler)>>,
    /// Next subscription ID
    next_id: std::sync::atomic::AtomicU64,
}

impl EventRouter {
    pub fn new() -> Self {
        Self {
            exact: RwLock::new(HashMap::new()),
            wildcards: RwLock::new(Vec::new()),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Subscribe to events matching a pattern.
    /// Supports exact match ("order.created") and wildcard ("order.*").
    pub async fn subscribe(&self, pattern: &str, handler: EventHandler) -> SubscriptionId {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        if pattern.contains('*') {
            let mut wildcards = self.wildcards.write().await;
            wildcards.push((pattern.to_string(), id, handler));
        } else {
            let mut exact = self.exact.write().await;
            exact
                .entry(pattern.to_string())
                .or_default()
                .push((id, handler));
        }

        id
    }

    /// Unsubscribe by subscription ID.
    pub async fn unsubscribe(&self, sub_id: SubscriptionId) {
        // Remove from exact subscriptions
        {
            let mut exact = self.exact.write().await;
            for subs in exact.values_mut() {
                subs.retain(|(id, _)| *id != sub_id);
            }
            exact.retain(|_, subs| !subs.is_empty());
        }

        // Remove from wildcard subscriptions
        {
            let mut wildcards = self.wildcards.write().await;
            wildcards.retain(|(_, id, _)| *id != sub_id);
        }
    }

    /// Dispatch an event to all matching subscribers.
    /// Returns the number of handlers that received the event.
    pub async fn dispatch(&self, event: &Event) -> usize {
        // Clone matching handlers while holding the lock, then release before calling.
        // This prevents deadlock if a handler calls subscribe/unsubscribe.
        let mut handlers_to_call: Vec<EventHandler> = Vec::new();

        // Exact match — collect handlers
        {
            let exact = self.exact.read().await;
            if let Some(subs) = exact.get(&event.name) {
                for (_, handler) in subs {
                    handlers_to_call.push(handler.clone());
                }
            }
        }

        // Wildcard match — collect handlers
        {
            let wildcards = self.wildcards.read().await;
            for (pattern, _, handler) in wildcards.iter() {
                if wildcard_matches(pattern, &event.name) {
                    handlers_to_call.push(handler.clone());
                }
            }
        }

        // Call handlers without any lock held
        let count = handlers_to_call.len();
        for handler in handlers_to_call {
            let event_clone = event.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handler(event_clone);
            }));
            if let Err(e) = result {
                let msg = e
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| e.downcast_ref::<String>().map(String::as_str))
                    .unwrap_or("unknown panic");
                eprintln!(
                    "[events] handler panicked for event '{}': {}",
                    event.name, msg
                );
            }
        }

        count
    }

    /// Get the total number of active subscriptions.
    pub async fn subscription_count(&self) -> usize {
        let exact: usize = self.exact.read().await.values().map(|v| v.len()).sum();
        let wildcards = self.wildcards.read().await.len();
        exact + wildcards
    }
}

impl Default for EventRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if an event name matches a wildcard pattern.
/// Supports "order.*" matching "order.created", "order.paid", etc.
/// Supports "**" matching everything.
pub fn wildcard_matches(pattern: &str, event_name: &str) -> bool {
    if pattern == "**" {
        return true;
    }
    if pattern == "*" {
        return !event_name.contains('.');
    }

    let pattern_parts: Vec<&str> = pattern.split('.').collect();
    let name_parts: Vec<&str> = event_name.split('.').collect();

    // Check for "**" (deep wildcard) — matches any depth including same level
    if let Some(last) = pattern_parts.last() {
        if *last == "**" {
            let prefix_parts = &pattern_parts[..pattern_parts.len() - 1];
            return name_parts.len() >= prefix_parts.len()
                && prefix_parts
                    .iter()
                    .zip(name_parts.iter())
                    .all(|(p, n)| p == n);
        }
    }

    // Length must match for exact and single-star wildcards
    if pattern_parts.len() != name_parts.len() {
        return false;
    }

    pattern_parts
        .iter()
        .zip(name_parts.iter())
        .all(|(p, n)| *p == "*" || p == n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn test_wildcard_exact() {
        assert!(wildcard_matches("order.created", "order.created"));
        assert!(!wildcard_matches("order.created", "order.paid"));
    }

    #[test]
    fn test_wildcard_star() {
        assert!(wildcard_matches("order.*", "order.created"));
        assert!(wildcard_matches("order.*", "order.paid"));
        assert!(!wildcard_matches("order.*", "payment.received"));
        assert!(!wildcard_matches("order.*", "order.items.created"));
    }

    #[test]
    fn test_wildcard_double_star() {
        assert!(wildcard_matches("order.**", "order.created"));
        assert!(wildcard_matches("order.**", "order.items.created"));
        assert!(!wildcard_matches("order.**", "payment.received"));
    }

    #[test]
    fn test_wildcard_catch_all() {
        assert!(wildcard_matches("*", "anything"));
        assert!(wildcard_matches("**", "anything.at.all"));
    }

    #[tokio::test]
    async fn test_subscribe_and_dispatch_exact() {
        let router = EventRouter::new();
        let count = Arc::new(AtomicUsize::new(0));
        let count_clone = count.clone();

        router
            .subscribe(
                "order.created",
                Arc::new(move |_| {
                    count_clone.fetch_add(1, Ordering::Relaxed);
                }),
            )
            .await;

        let event = Event::new("order.created", "{}");
        let dispatched = router.dispatch(&event).await;

        assert_eq!(dispatched, 1);
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_subscribe_and_dispatch_wildcard() {
        let router = EventRouter::new();
        let count = Arc::new(AtomicUsize::new(0));
        let count_clone = count.clone();

        router
            .subscribe(
                "order.*",
                Arc::new(move |_| {
                    count_clone.fetch_add(1, Ordering::Relaxed);
                }),
            )
            .await;

        let dispatched1 = router.dispatch(&Event::new("order.created", "{}")).await;
        let dispatched2 = router.dispatch(&Event::new("order.paid", "{}")).await;
        let dispatched3 = router.dispatch(&Event::new("payment.received", "{}")).await;

        assert_eq!(dispatched1, 1);
        assert_eq!(dispatched2, 1);
        assert_eq!(dispatched3, 0);
        assert_eq!(count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn test_multiple_subscribers() {
        let router = EventRouter::new();
        let count = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let c = count.clone();
            router
                .subscribe(
                    "test.event",
                    Arc::new(move |_| {
                        c.fetch_add(1, Ordering::Relaxed);
                    }),
                )
                .await;
        }

        router.dispatch(&Event::new("test.event", "{}")).await;
        assert_eq!(count.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn test_unsubscribe() {
        let router = EventRouter::new();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();

        let sub_id = router
            .subscribe(
                "test.event",
                Arc::new(move |_| {
                    c.fetch_add(1, Ordering::Relaxed);
                }),
            )
            .await;

        router.dispatch(&Event::new("test.event", "{}")).await;
        assert_eq!(count.load(Ordering::Relaxed), 1);

        router.unsubscribe(sub_id).await;
        router.dispatch(&Event::new("test.event", "{}")).await;
        assert_eq!(count.load(Ordering::Relaxed), 1); // No increment after unsub
    }

    #[tokio::test]
    async fn test_subscription_count() {
        let router = EventRouter::new();
        assert_eq!(router.subscription_count().await, 0);

        router.subscribe("a", Arc::new(|_| {})).await;
        router.subscribe("b.*", Arc::new(|_| {})).await;
        assert_eq!(router.subscription_count().await, 2);
    }
}

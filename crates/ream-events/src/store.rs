//! Event store trait and MemoryStore implementation.
//!
//! @implements FR7, FR8, FR15, FR16

use crate::event::Event;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Event processing status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventStatus {
    Pending,
    Processing,
    Success,
    Failed { error: String, severity: String },
    Retrying { attempt: u8 },
}

/// Tracked event with its processing state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedEvent {
    pub event: Event,
    pub status: EventStatus,
    pub retry_count: u8,
    pub max_retries: u8,
    pub last_error: Option<String>,
}

/// Trait for event storage backends.
/// MemoryStore for dev, RedisStore for production (enable `redis-store` feature).
pub trait EventStore: Send + Sync {
    /// Store a new event.
    fn push(&self, event: Event, max_retries: u8) -> Result<(), String>;

    /// Acknowledge event completion.
    fn ack(&self, event_id: &str, status: EventStatus) -> Result<(), String>;

    /// Get pending events (for retry processing).
    fn get_pending(&self) -> Vec<TrackedEvent>;

    /// Get failed events (dead letter queue).
    fn get_failed(&self) -> Vec<TrackedEvent>;

    /// Get event by ID.
    fn get(&self, event_id: &str) -> Option<TrackedEvent>;

    /// Get total event count.
    fn count(&self) -> usize;
}

/// Maximum events to keep in memory before eviction.
const DEFAULT_MAX_EVENTS: usize = 10_000;

/// In-memory event store for development and testing.
pub struct MemoryStore {
    events: Mutex<HashMap<String, TrackedEvent>>,
    max_events: usize,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(HashMap::new()),
            max_events: DEFAULT_MAX_EVENTS,
        }
    }

    /// Evict completed events (Success/Failed) when over capacity.
    fn evict_if_needed(events: &mut HashMap<String, TrackedEvent>, max: usize) {
        if events.len() <= max {
            return;
        }
        // Remove completed events first (Success, then Failed)
        let to_remove: Vec<String> = events.iter()
            .filter(|(_, t)| matches!(t.status, EventStatus::Success | EventStatus::Failed { .. }))
            .map(|(id, _)| id.clone())
            .collect();
        for id in to_remove {
            events.remove(&id);
            if events.len() <= max {
                break;
            }
        }
        // Failsafe: if we are still over capacity (e.g. only pending/retrying),
        // evict arbitrary entries to enforce a hard memory ceiling.
        if events.len() > max {
            let overflow = events.len() - max;
            let extra_ids: Vec<String> = events.keys().take(overflow).cloned().collect();
            for id in &extra_ids {
                if let Some(evicted) = events.get(id) {
                    eprintln!(
                        "[events] MemoryStore evicting pending event '{}' (name='{}') to enforce cap of {}",
                        evicted.event.id, evicted.event.name, max
                    );
                }
                events.remove(id);
            }
            eprintln!(
                "[events] MemoryStore dropped {} pending event(s) to enforce cap of {}",
                extra_ids.len(),
                max
            );
        }
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStore for MemoryStore {
    fn push(&self, event: Event, max_retries: u8) -> Result<(), String> {
        let mut store = self.events.lock().map_err(|e| format!("{}", e))?;
        let tracked = TrackedEvent {
            event: event.clone(),
            status: EventStatus::Pending,
            retry_count: 0,
            max_retries,
            last_error: None,
        };
        store.insert(event.id.clone(), tracked);
        Self::evict_if_needed(&mut store, self.max_events);
        Ok(())
    }

    fn ack(&self, event_id: &str, status: EventStatus) -> Result<(), String> {
        let mut store = self.events.lock().map_err(|e| format!("{}", e))?;
        if let Some(tracked) = store.get_mut(event_id) {
            if let EventStatus::Retrying { attempt } = &status {
                tracked.retry_count = *attempt;
            }
            if let EventStatus::Failed { ref error, .. } = status {
                tracked.last_error = Some(error.clone());
            }
            tracked.status = status;
            Ok(())
        } else {
            Err(format!("Event '{}' not found", event_id))
        }
    }

    fn get_pending(&self) -> Vec<TrackedEvent> {
        let store = self.events.lock().unwrap_or_else(|e| e.into_inner());
        store.values()
            .filter(|t| matches!(t.status, EventStatus::Pending | EventStatus::Retrying { .. }))
            .cloned()
            .collect()
    }

    fn get_failed(&self) -> Vec<TrackedEvent> {
        let store = self.events.lock().unwrap_or_else(|e| e.into_inner());
        store.values()
            .filter(|t| matches!(t.status, EventStatus::Failed { .. }))
            .cloned()
            .collect()
    }

    fn get(&self, event_id: &str) -> Option<TrackedEvent> {
        let store = self.events.lock().unwrap_or_else(|e| e.into_inner());
        store.get(event_id).cloned()
    }

    fn count(&self) -> usize {
        let store = self.events.lock().unwrap_or_else(|e| e.into_inner());
        store.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_store_push_and_get() {
        let store = MemoryStore::new();
        let event = Event::new("test", "{}");
        let id = event.id.clone();
        store.push(event, 3).unwrap();

        let tracked = store.get(&id).unwrap();
        assert_eq!(tracked.status, EventStatus::Pending);
        assert_eq!(tracked.max_retries, 3);
    }

    #[test]
    fn test_memory_store_ack_success() {
        let store = MemoryStore::new();
        let event = Event::new("test", "{}");
        let id = event.id.clone();
        store.push(event, 3).unwrap();

        store.ack(&id, EventStatus::Success).unwrap();
        let tracked = store.get(&id).unwrap();
        assert_eq!(tracked.status, EventStatus::Success);
    }

    #[test]
    fn test_memory_store_ack_failed() {
        let store = MemoryStore::new();
        let event = Event::new("test", "{}");
        let id = event.id.clone();
        store.push(event, 3).unwrap();

        store.ack(&id, EventStatus::Failed {
            error: "DB error".to_string(),
            severity: "critical".to_string(),
        }).unwrap();

        let tracked = store.get(&id).unwrap();
        assert!(matches!(tracked.status, EventStatus::Failed { .. }));
        assert_eq!(tracked.last_error.as_deref(), Some("DB error"));
    }

    #[test]
    fn test_memory_store_get_pending() {
        let store = MemoryStore::new();
        store.push(Event::new("a", "{}"), 3).unwrap();
        store.push(Event::new("b", "{}"), 3).unwrap();

        let pending = store.get_pending();
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn test_memory_store_get_failed_dead_letter() {
        let store = MemoryStore::new();
        let event = Event::new("test", "{}");
        let id = event.id.clone();
        store.push(event, 3).unwrap();

        store.ack(&id, EventStatus::Failed {
            error: "max retries".to_string(),
            severity: "warning".to_string(),
        }).unwrap();

        let failed = store.get_failed();
        assert_eq!(failed.len(), 1);
    }

    #[test]
    fn test_memory_store_retrying() {
        let store = MemoryStore::new();
        let event = Event::new("test", "{}");
        let id = event.id.clone();
        store.push(event, 3).unwrap();

        store.ack(&id, EventStatus::Retrying { attempt: 1 }).unwrap();
        let tracked = store.get(&id).unwrap();
        assert_eq!(tracked.retry_count, 1);
    }

    #[test]
    fn test_event_status_serializes_camelcase() {
        let status = EventStatus::Failed {
            error: "test".to_string(),
            severity: "critical".to_string(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"failed\"") || json.contains("failed"));
    }
}

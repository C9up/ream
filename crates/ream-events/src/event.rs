//! Event types for event bus.
//!
//! @implements FR1, FR9, FR10

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Event payload that traverses the event bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Unique event ID
    pub id: String,

    /// Event name (e.g., "order.created")
    pub name: String,

    /// Serialized payload (JSON string)
    pub data: String,

    /// Correlation ID for chain tracing
    pub correlation_id: String,

    /// Causation ID (parent event that caused this one)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,

    /// Timestamp (ISO 8601)
    pub timestamp: String,

    /// Source service name
    #[serde(default)]
    pub source_service: String,

    // Distribution-ready metadata (designed now, used later)
    /// Node ID for multi-node distribution
    #[serde(default)]
    pub node_id: String,

    /// Max hops between nodes
    #[serde(default)]
    pub ttl: u8,
}

impl Event {
    /// Create a new event with auto-generated ID and timestamp.
    pub fn new(name: impl Into<String>, data: impl Into<String>) -> Self {
        let id = Uuid::new_v4().to_string();
        let now = chrono_now();
        Self {
            correlation_id: id.clone(),
            id,
            name: name.into(),
            data: data.into(),
            causation_id: None,
            timestamp: now,
            source_service: String::new(),
            node_id: "local".to_string(),
            ttl: 255,
        }
    }

    /// Create a child event that inherits the correlation ID.
    pub fn child(&self, name: impl Into<String>, data: impl Into<String>) -> Self {
        let mut child = Event::new(name, data);
        child.correlation_id = self.correlation_id.clone();
        child.causation_id = Some(self.id.clone());
        child
    }
}

/// Get current time as ISO 8601 string (no external chrono dependency).
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch");
    let secs = duration.as_secs();
    // Convert to ISO 8601: YYYY-MM-DDTHH:MM:SSZ
    // Manual conversion without chrono crate — @c9up/chronos will replace this
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch to year/month/day (simplified civil calendar)
    let (year, month, day) = days_to_date(days);

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hours, minutes, seconds)
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from https://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_creation() {
        let event = Event::new("order.created", r#"{"orderId":"123"}"#);
        assert_eq!(event.name, "order.created");
        assert!(!event.id.is_empty());
        assert_eq!(event.correlation_id, event.id);
        assert!(event.causation_id.is_none());
        assert_eq!(event.node_id, "local");
    }

    #[test]
    fn test_event_child() {
        let parent = Event::new("payment.received", "{}");
        let child = parent.child("invoice.created", "{}");
        assert_eq!(child.correlation_id, parent.correlation_id);
        assert_eq!(child.causation_id.as_deref(), Some(parent.id.as_str()));
        assert_ne!(child.id, parent.id);
    }

    #[test]
    fn test_event_serializes_camelcase() {
        let event = Event::new("test", "{}");
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"correlationId\""));
        assert!(json.contains("\"sourceService\""));
        assert!(json.contains("\"nodeId\""));
        assert!(!json.contains("\"correlation_id\""));
    }
}

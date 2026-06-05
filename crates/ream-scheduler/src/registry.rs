//! Task registry — stores registered scheduled tasks and drives invocation.
//!
//! The registry holds an `Arc<Mutex<HashMap<..>>>` of [`RegisteredTask`]
//! entries. The [`Ticker`](crate::ticker::Ticker) snapshots due tasks under
//! the lock, updates their `next_run`, releases the lock, then invokes
//! them. Invocation goes through a [`TaskInvoker`] trait object so the
//! core crate does not depend on NAPI types.

use crate::parser::Schedule;
use chrono::{DateTime, Utc};
use ream_napi_core::ReamError;
use std::collections::HashMap;
use std::sync::Arc;

/// Payload delivered to a task invocation.
#[derive(Debug, Clone)]
pub struct TaskPayload {
    /// Stable task identifier (e.g. `"MyService.cleanup"`).
    pub task_name: String,
    /// The instant (ms epoch) at which the tick decided to fire the task.
    pub scheduled_for_ms: i64,
}

/// Trait object used by the ticker to invoke a registered task.
///
/// Implementations are responsible for dispatching to whatever handler
/// surface they represent (native Rust closure, NAPI ThreadsafeFunction,
/// etc.). Invocation must not block the ticker for more than a trivial
/// duration — long work should be offloaded.
pub trait TaskInvoker: Send + Sync {
    /// Invoke the task. Implementations must not panic; any panic is
    /// caught by the ticker (see [`crate::ticker`]), but returning
    /// cleanly is preferred.
    fn invoke(&self, payload: TaskPayload);
}

/// Optional hook notified when a registered task panics.
///
/// Story 28.4 installs a event-bus-backed implementation; this story only
/// provides the seam plus a unit test.
pub trait ObservabilityHook: Send + Sync {
    /// Called after a task panic is caught by the ticker.
    fn on_task_panic(&self, task_name: &str, panic_message: &str);
}

/// Internal registry entry.
pub(crate) struct RegisteredTask {
    pub(crate) name: String,
    pub(crate) schedule: Schedule,
    pub(crate) next_run: DateTime<Utc>,
    pub(crate) invoker: Arc<dyn TaskInvoker>,
}

impl RegisteredTask {
    pub(crate) fn new(
        name: String,
        schedule: Schedule,
        invoker: Arc<dyn TaskInvoker>,
        now: DateTime<Utc>,
    ) -> Result<Self, ReamError> {
        let next_run = schedule.next_after(now).ok_or_else(|| {
            ReamError::new(
                "CRON_NO_FIRE",
                "Cron expression has no future fire time after `now`",
            )
            .with_context("task", &name)
        })?;
        Ok(Self {
            name,
            schedule,
            next_run,
            invoker,
        })
    }
}

/// Error returned when registering a name that already exists.
pub(crate) fn duplicate_task_error(name: &str) -> ReamError {
    ReamError::new(
        "DUPLICATE_TASK",
        format!("Task '{}' is already registered", name),
    )
    .with_hint("Unregister the existing task first or use a unique name")
    .with_context("task", name)
}

pub(crate) type RegistryMap = HashMap<String, RegisteredTask>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_cron;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingInvoker {
        count: Arc<AtomicUsize>,
    }

    impl TaskInvoker for CountingInvoker {
        fn invoke(&self, _payload: TaskPayload) {
            self.count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn registered_task_computes_next_run() {
        let schedule = parse_cron("*/5 * * * *").unwrap();
        let now = Utc::now();
        let invoker = Arc::new(CountingInvoker {
            count: Arc::new(AtomicUsize::new(0)),
        });
        let task = RegisteredTask::new("job".to_string(), schedule, invoker, now).unwrap();
        assert!(task.next_run > now);
    }

    #[test]
    fn duplicate_task_error_carries_task_name() {
        let err = duplicate_task_error("job");
        assert_eq!(err.code, "DUPLICATE_TASK");
        assert_eq!(
            err.context.get("task").map(|s| s.as_str()),
            Some("job")
        );
    }
}

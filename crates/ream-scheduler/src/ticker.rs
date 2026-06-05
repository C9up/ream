//! Ticker — single Tokio interval loop that fires due tasks.
//!
//! One `tokio::time::interval` at 1 s granularity drives the entire
//! scheduler. `MissedTickBehavior::Skip` prevents stalled runtimes from
//! piling up ticks. Each task invocation is wrapped in
//! `std::panic::catch_unwind`; panics are forwarded to the optional
//! [`ObservabilityHook`] and never abort the loop.
//!
//! # Missed-fire semantics
//!
//! When the runtime stalls (GC pause, suspend/resume, blocked thread)
//! past multiple scheduled fires for the same task, the ticker fires
//! that task **once** at the next tick and advances `next_run` to the
//! next fire strictly after the current wall clock. Intermediate missed
//! fires are **skipped**, matching the interval's own
//! `MissedTickBehavior::Skip`. A `*/5 * * * *` task that survives a
//! 10-minute stall fires once, not twice. Catch-up semantics are out of
//! scope for this story and would need an explicit opt-in at register
//! time.

use crate::registry::{ObservabilityHook, RegistryMap, TaskPayload};
use chrono::{DateTime, Utc};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, RwLock};
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tokio::time::{interval, Duration, MissedTickBehavior};

/// Handle to the running tick loop. `start` is idempotent — calling it
/// while `cancel_tx` is `Some` returns immediately. `stop` signals the
/// loop to exit at its next `select!` poll.
pub(crate) struct Ticker {
    cancel_tx: Option<oneshot::Sender<()>>,
    /// Counts how many times `start` actually spawned a background task.
    /// Used by tests to assert idempotence (a second `start` while
    /// already running must not increment this).
    #[cfg(test)]
    spawn_count: usize,
}

impl Ticker {
    pub(crate) fn new() -> Self {
        Self {
            cancel_tx: None,
            #[cfg(test)]
            spawn_count: 0,
        }
    }

    /// Spawn the tick loop on the shared runtime. Idempotent.
    pub(crate) fn start(
        &mut self,
        registry: Arc<Mutex<RegistryMap>>,
        hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>>,
        runtime: &Runtime,
    ) {
        if self.cancel_tx.is_some() {
            return;
        }
        let (tx, rx) = oneshot::channel::<()>();
        self.cancel_tx = Some(tx);
        #[cfg(test)]
        {
            self.spawn_count += 1;
        }

        runtime.spawn(async move {
            let mut ticker = interval(Duration::from_secs(1));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            // Discard the immediate first tick so the first real fire
            // happens no earlier than +1 s — avoids double-invoking a
            // task that was registered in the same second the ticker
            // started.
            ticker.tick().await;

            let mut cancel = rx;
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        dispatch_due_tasks(&registry, &hook);
                    }
                    _ = &mut cancel => {
                        break;
                    }
                }
            }
        });
    }

    /// Cancel the tick loop if running.
    pub(crate) fn stop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }

    /// Test hook — true if `start` is currently active.
    #[cfg(test)]
    pub(crate) fn is_running(&self) -> bool {
        self.cancel_tx.is_some()
    }

    /// Test hook — how many background tasks this ticker has spawned.
    #[cfg(test)]
    pub(crate) fn spawn_count(&self) -> usize {
        self.spawn_count
    }
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Walk the registry, collect due invocations under a brief lock, drop
/// the lock, then invoke them. Keeping the lock scope tight avoids
/// stalling registration during fan-out.
///
/// `next_run` is advanced via `Schedule::next_after(now)` — missed
/// fires are dropped (see module-level "Missed-fire semantics").
fn dispatch_due_tasks(
    registry: &Arc<Mutex<RegistryMap>>,
    hook: &Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>>,
) {
    let now = Utc::now();
    let mut due: Vec<(String, Arc<dyn crate::registry::TaskInvoker>, TaskPayload)> = Vec::new();
    let mut poisoned_recovered = false;

    {
        let mut guard = match registry.lock() {
            Ok(g) => g,
            // Poisoned mutex — another thread panicked while holding the
            // lock. Recover via `into_inner`, but flag the event so the
            // observability hook is notified after lock release.
            Err(poisoned) => {
                poisoned_recovered = true;
                poisoned.into_inner()
            }
        };
        for task in guard.values_mut() {
            if task.next_run <= now {
                let payload = TaskPayload {
                    task_name: task.name.clone(),
                    scheduled_for_ms: task.next_run.timestamp_millis(),
                };
                due.push((task.name.clone(), Arc::clone(&task.invoker), payload));
                // Advance next_run past `now`. If the schedule has no
                // future fire (theoretical — cron 5-field grammar always
                // produces one for valid expressions), park the task at
                // DateTime::MAX_UTC so it never re-fires instead of
                // hot-looping on the past `next_run`.
                match task.schedule.next_after(now) {
                    Some(next) => task.next_run = next,
                    None => task.next_run = DateTime::<Utc>::MAX_UTC,
                }
            }
        }
    }

    if poisoned_recovered {
        notify_hook(hook, "__registry__", "registry mutex poisoned during dispatch — recovered via into_inner");
    }

    for (name, invoker, payload) in due {
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            invoker.invoke(payload);
        }));
        if let Err(panic_payload) = result {
            let message = panic_message(panic_payload.as_ref());
            notify_hook(hook, &name, &message);
        }
    }
}

fn notify_hook(
    hook: &Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>>,
    task_name: &str,
    message: &str,
) {
    if let Ok(guard) = hook.read() {
        if let Some(h) = guard.as_ref() {
            h.on_task_panic(task_name, message);
        }
    }
}

/// Test-only wrapper around the internal dispatch path so unit tests
/// can exercise panic handling and hook invocation without waiting on
/// a real tick.
#[cfg(test)]
pub(crate) fn __test_dispatch_due_tasks(
    registry: &Arc<Mutex<RegistryMap>>,
    hook: &Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>>,
) {
    dispatch_due_tasks(registry, hook);
}

/// Best-effort extraction of a human-readable message from a panic
/// payload. `&str` and `String` panics produce their literal message;
/// common primitive types (`panic_any(42_i32)`, `panic_any(true)`)
/// produce a typed description; everything else falls back to a stable
/// "non-string panic payload" marker so the observability hook still
/// sees *something*.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(n) = payload.downcast_ref::<i32>() {
        format!("non-string panic payload: i32 = {}", n)
    } else if let Some(n) = payload.downcast_ref::<i64>() {
        format!("non-string panic payload: i64 = {}", n)
    } else if let Some(n) = payload.downcast_ref::<u32>() {
        format!("non-string panic payload: u32 = {}", n)
    } else if let Some(n) = payload.downcast_ref::<u64>() {
        format!("non-string panic payload: u64 = {}", n)
    } else if let Some(b) = payload.downcast_ref::<bool>() {
        format!("non-string panic payload: bool = {}", b)
    } else {
        "non-string panic payload of unrecognized type".to_string()
    }
}

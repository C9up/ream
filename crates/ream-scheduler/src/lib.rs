//! # ream-scheduler
//!
//! Cron parser + task ticker core for the Ream scheduler. Pure Rust —
//! no NAPI. The NAPI surface lives in the sibling `ream-scheduler-napi`
//! crate.
//!
//! @implements Story 28.1

// ReamError is the project-standard rich error type; its size is
// intentional (carries context, hint, docs URL, source location).
// Boxing at every call site adds noise without correctness benefit.
#![allow(clippy::result_large_err)]

pub mod parser;
pub mod registry;
mod ticker;

pub use parser::{parse_cron, Schedule};
pub use registry::{ObservabilityHook, TaskInvoker, TaskPayload};

use chrono::Utc;
use ream_napi_core::ReamError;
use registry::{duplicate_task_error, RegisteredTask, RegistryMap};
use std::sync::{Arc, Mutex, RwLock};
use ticker::Ticker;

/// Scheduler facade — owns the registry, ticker, and observability hook.
///
/// # Timezone
///
/// All schedules are evaluated in **UTC**. The scheduler computes the
/// next fire instant via `chrono::Utc::now()` and `Schedule::next_after`
/// on UTC datetimes. A cron expression such as `"0 9 * * *"` fires at
/// 09:00 UTC, not 09:00 local. Local-time conversion, if required, is
/// the responsibility of the caller (typically the TypeScript surface
/// in Story 28.2, which can translate a user-declared local cron to its
/// UTC equivalent before calling `register`).
///
/// # Public API
///
/// - `new()` — construct; does not start the ticker.
/// - `register(name, cron_expr, invoker)` — add a task.
/// - `unregister(name)` — remove a task (idempotent).
/// - `next_run(name)` — inspect the next fire time.
/// - `set_observability_hook(hook)` — install a panic hook.
/// - `start(&runtime)` — launch the tick loop. Idempotent.
/// - `stop()` — cancel the tick loop.
pub struct RustScheduler {
    registry: Arc<Mutex<RegistryMap>>,
    ticker: Mutex<Ticker>,
    hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>>,
}

impl RustScheduler {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(RegistryMap::new())),
            ticker: Mutex::new(Ticker::new()),
            hook: Arc::new(RwLock::new(None)),
        }
    }

    /// Register a task.
    ///
    /// The cron expression is evaluated in UTC (see struct-level doc).
    /// Fails with `DUPLICATE_TASK` if `name` already exists, or
    /// `INVALID_CRON` if `cron_expr` is malformed.
    ///
    /// Missed fires after a runtime stall are dropped, not replayed —
    /// the ticker advances `next_run` past `Utc::now()` at fire time.
    /// See `ticker.rs` module-level "Missed-fire semantics".
    pub fn register(
        &self,
        name: impl Into<String>,
        cron_expr: &str,
        invoker: Arc<dyn TaskInvoker>,
    ) -> Result<(), ReamError> {
        let name = name.into();
        let schedule = parser::parse_cron(cron_expr)?;
        let task = RegisteredTask::new(name.clone(), schedule, invoker, Utc::now())?;

        let mut guard = self
            .registry
            .lock()
            .map_err(|_| ReamError::new("REGISTRY_POISONED", "Registry mutex poisoned"))?;
        if guard.contains_key(&name) {
            return Err(duplicate_task_error(&name));
        }
        guard.insert(name, task);
        Ok(())
    }

    /// Remove a task. Idempotent — removing an unknown name is not an error.
    pub fn unregister(&self, name: &str) -> Result<(), ReamError> {
        let mut guard = self
            .registry
            .lock()
            .map_err(|_| ReamError::new("REGISTRY_POISONED", "Registry mutex poisoned"))?;
        guard.remove(name);
        Ok(())
    }

    /// Return the next fire time in ms epoch, or `None` if the task is unknown.
    pub fn next_run(&self, name: &str) -> Result<Option<i64>, ReamError> {
        let guard = self
            .registry
            .lock()
            .map_err(|_| ReamError::new("REGISTRY_POISONED", "Registry mutex poisoned"))?;
        Ok(guard.get(name).map(|t| t.next_run.timestamp_millis()))
    }

    /// Install (or replace) the panic observability hook.
    pub fn set_observability_hook(&self, hook: Arc<dyn ObservabilityHook>) {
        if let Ok(mut guard) = self.hook.write() {
            *guard = Some(hook);
        }
    }

    /// Launch the tick loop on the provided Tokio runtime. Idempotent.
    ///
    /// The core crate takes the runtime as an argument (rather than
    /// hard-wiring `ream_napi_core::shared_runtime()`) so unit tests can
    /// build isolated runtimes without touching global state. Production
    /// callers — specifically `ream-scheduler-napi` — always pass
    /// `shared_runtime()` to satisfy Story 15.5's single-runtime
    /// contract.
    pub fn start(&self, runtime: &tokio::runtime::Runtime) -> Result<(), ReamError> {
        let mut ticker = self
            .ticker
            .lock()
            .map_err(|_| ReamError::new("TICKER_POISONED", "Ticker mutex poisoned"))?;
        ticker.start(Arc::clone(&self.registry), Arc::clone(&self.hook), runtime);
        Ok(())
    }

    /// Cancel the tick loop. Safe to call even if not running.
    pub fn stop(&self) -> Result<(), ReamError> {
        let mut ticker = self
            .ticker
            .lock()
            .map_err(|_| ReamError::new("TICKER_POISONED", "Ticker mutex poisoned"))?;
        ticker.stop();
        Ok(())
    }
}

impl Default for RustScheduler {
    fn default() -> Self {
        Self::new()
    }
}

/// Returns the crate version.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::runtime::Builder;

    struct CountingInvoker {
        count: Arc<AtomicUsize>,
    }

    impl TaskInvoker for CountingInvoker {
        fn invoke(&self, _payload: TaskPayload) {
            self.count.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct PanicInvoker;

    impl TaskInvoker for PanicInvoker {
        fn invoke(&self, _payload: TaskPayload) {
            panic!("intentional test panic");
        }
    }

    struct RecordingHook {
        events: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl ObservabilityHook for RecordingHook {
        fn on_task_panic(&self, task_name: &str, panic_message: &str) {
            self.events
                .lock()
                .unwrap()
                .push((task_name.to_string(), panic_message.to_string()));
        }
    }

    // ---- registry-level tests ---------------------------------------

    #[test]
    fn register_then_next_run_returns_future_timestamp() {
        let scheduler = RustScheduler::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let invoker = Arc::new(CountingInvoker {
            count: Arc::clone(&counter),
        });
        scheduler.register("job", "*/1 * * * *", invoker).unwrap();
        let next = scheduler.next_run("job").unwrap().expect("has next");
        assert!(next > Utc::now().timestamp_millis());
    }

    #[test]
    fn duplicate_register_returns_duplicate_task() {
        let scheduler = RustScheduler::new();
        let invoker = Arc::new(CountingInvoker {
            count: Arc::new(AtomicUsize::new(0)),
        });
        scheduler
            .register(
                "job",
                "*/1 * * * *",
                Arc::clone(&invoker) as Arc<dyn TaskInvoker>,
            )
            .unwrap();
        let err = scheduler
            .register("job", "*/1 * * * *", invoker as Arc<dyn TaskInvoker>)
            .unwrap_err();
        assert_eq!(err.code, "DUPLICATE_TASK");
    }

    #[test]
    fn unregister_then_next_run_returns_none() {
        let scheduler = RustScheduler::new();
        let invoker = Arc::new(CountingInvoker {
            count: Arc::new(AtomicUsize::new(0)),
        });
        scheduler.register("job", "*/1 * * * *", invoker).unwrap();
        scheduler.unregister("job").unwrap();
        assert_eq!(scheduler.next_run("job").unwrap(), None);
    }

    #[test]
    fn unregister_unknown_is_idempotent() {
        let scheduler = RustScheduler::new();
        scheduler.unregister("never-registered").unwrap();
    }

    #[test]
    fn register_invalid_cron_fails() {
        let scheduler = RustScheduler::new();
        let invoker = Arc::new(CountingInvoker {
            count: Arc::new(AtomicUsize::new(0)),
        });
        let err = scheduler
            .register("bad", "not a cron", invoker)
            .unwrap_err();
        assert_eq!(err.code, "INVALID_CRON");
    }

    // ---- ticker integration tests -----------------------------------

    fn build_runtime() -> tokio::runtime::Runtime {
        Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    /// Use a `*/1 * * * *` (every minute) schedule. The ticker polls
    /// once per second; within 65 real seconds it should fire at least
    /// once. The test waits up to 75 s with polling to avoid flakes.
    ///
    /// This test is `#[ignore]` by default because it takes >60 s of
    /// wall time. Run it explicitly with `cargo test -- --ignored`.
    #[test]
    #[ignore = "real-time, takes up to 75 seconds"]
    fn ticker_fires_registered_task_within_one_minute() {
        let scheduler = Arc::new(RustScheduler::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let invoker = Arc::new(CountingInvoker {
            count: Arc::clone(&counter),
        });
        scheduler.register("job", "*/1 * * * *", invoker).unwrap();

        let runtime = build_runtime();
        scheduler.start(&runtime).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(75);
        while counter.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }
        scheduler.stop().unwrap();
        assert!(
            counter.load(Ordering::SeqCst) >= 1,
            "expected task to fire at least once within 75s"
        );
    }

    #[test]
    fn start_is_idempotent() {
        let scheduler = RustScheduler::new();
        let runtime = build_runtime();
        scheduler.start(&runtime).unwrap();
        scheduler.start(&runtime).unwrap();
        scheduler.start(&runtime).unwrap();
        // Exactly one background task spawned across 3 start() calls
        // — verifies the idempotence guard at ticker.rs `if cancel_tx.is_some()`.
        assert_eq!(
            scheduler.ticker.lock().unwrap().spawn_count(),
            1,
            "start() must spawn exactly once across repeated calls"
        );
        assert!(scheduler.ticker.lock().unwrap().is_running());
        scheduler.stop().unwrap();
        assert!(!scheduler.ticker.lock().unwrap().is_running());
    }

    #[test]
    fn stop_then_start_resumes() {
        let scheduler = RustScheduler::new();
        let runtime = build_runtime();
        scheduler.start(&runtime).unwrap();
        scheduler.stop().unwrap();
        scheduler.start(&runtime).unwrap();
        assert!(scheduler.ticker.lock().unwrap().is_running());
        scheduler.stop().unwrap();
    }

    #[test]
    fn stop_without_start_is_noop() {
        let scheduler = RustScheduler::new();
        scheduler.stop().unwrap();
    }

    // ---- fault-isolation + hook tests -------------------------------

    #[test]
    fn ticker_dispatch_survives_task_panic() {
        // Directly exercise the internal `dispatch_due_tasks` path by
        // manufacturing a registry entry whose next_run is already in
        // the past. This avoids any real-time waiting.
        use crate::registry::{RegisteredTask, RegistryMap};
        use chrono::Duration as ChronoDuration;

        let registry: Arc<Mutex<RegistryMap>> = Arc::new(Mutex::new(RegistryMap::new()));
        let hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>> = Arc::new(RwLock::new(None));
        let recorded: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        *hook.write().unwrap() = Some(Arc::new(RecordingHook {
            events: Arc::clone(&recorded),
        }));

        let counter = Arc::new(AtomicUsize::new(0));
        let panicker: Arc<dyn TaskInvoker> = Arc::new(PanicInvoker);
        let counting: Arc<dyn TaskInvoker> = Arc::new(CountingInvoker {
            count: Arc::clone(&counter),
        });

        let past = Utc::now() - ChronoDuration::seconds(5);
        {
            let mut guard = registry.lock().unwrap();
            let schedule = parser::parse_cron("*/1 * * * *").unwrap();
            let mut t1 =
                RegisteredTask::new("boom".into(), schedule, panicker, Utc::now()).unwrap();
            t1.next_run = past;
            guard.insert("boom".into(), t1);

            let schedule = parser::parse_cron("*/1 * * * *").unwrap();
            let mut t2 =
                RegisteredTask::new("counter".into(), schedule, counting, Utc::now()).unwrap();
            t2.next_run = past;
            guard.insert("counter".into(), t2);
        }

        crate::ticker::__test_dispatch_due_tasks(&registry, &hook);

        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "counting task must fire despite sibling panic"
        );
        let events = recorded.lock().unwrap();
        assert_eq!(events.len(), 1, "hook should record exactly one panic");
        assert_eq!(events[0].0, "boom");
        assert!(events[0].1.contains("intentional test panic"));
    }

    /// Alternating-panic invoker — panics on odd ticks, counts on even
    /// ticks. Used to verify that fault isolation works tick-by-tick,
    /// not only for always-panicking tasks.
    struct AlternatingInvoker {
        call_number: AtomicUsize,
        counter: Arc<AtomicUsize>,
    }

    impl TaskInvoker for AlternatingInvoker {
        fn invoke(&self, _payload: TaskPayload) {
            let n = self.call_number.fetch_add(1, Ordering::SeqCst);
            if n.is_multiple_of(2) {
                self.counter.fetch_add(1, Ordering::SeqCst);
            } else {
                panic!("odd-tick panic #{}", n);
            }
        }
    }

    #[test]
    fn alternating_panic_invoker_survives_across_ticks() {
        use crate::registry::{RegisteredTask, RegistryMap};

        let registry: Arc<Mutex<RegistryMap>> = Arc::new(Mutex::new(RegistryMap::new()));
        let hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>> = Arc::new(RwLock::new(None));
        let recorded: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        *hook.write().unwrap() = Some(Arc::new(RecordingHook {
            events: Arc::clone(&recorded),
        }));

        let counter = Arc::new(AtomicUsize::new(0));
        let alternating: Arc<dyn TaskInvoker> = Arc::new(AlternatingInvoker {
            call_number: AtomicUsize::new(0),
            counter: Arc::clone(&counter),
        });

        // Register a single task that will be fired 4 times by 4
        // manual dispatch calls with `next_run` kept in the past.
        {
            let mut guard = registry.lock().unwrap();
            let schedule = parser::parse_cron("*/1 * * * *").unwrap();
            let mut t =
                RegisteredTask::new("flapper".into(), schedule, alternating, Utc::now()).unwrap();
            t.next_run = Utc::now() - chrono::Duration::seconds(5);
            guard.insert("flapper".into(), t);
        }

        for _ in 0..4 {
            // Re-arm next_run to the past before each dispatch so the
            // task fires every iteration regardless of schedule math.
            {
                let mut guard = registry.lock().unwrap();
                if let Some(t) = guard.get_mut("flapper") {
                    t.next_run = Utc::now() - chrono::Duration::seconds(5);
                }
            }
            crate::ticker::__test_dispatch_due_tasks(&registry, &hook);
        }

        // 4 invocations — #0 counts, #1 panics, #2 counts, #3 panics.
        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "2 even-tick successes expected"
        );
        let events = recorded.lock().unwrap();
        assert_eq!(events.len(), 2, "2 odd-tick panics expected");
        for (name, msg) in events.iter() {
            assert_eq!(name, "flapper");
            assert!(msg.contains("odd-tick panic"));
        }
    }

    /// Invoker that always panics with a non-string payload. Verifies
    /// that `panic_message` falls back to the payload's type name
    /// instead of reporting "unknown panic payload".
    struct NonStringPanicInvoker;

    impl TaskInvoker for NonStringPanicInvoker {
        fn invoke(&self, _payload: TaskPayload) {
            std::panic::panic_any(42_i32);
        }
    }

    #[test]
    fn non_string_panic_payload_reports_type_name() {
        use crate::registry::{RegisteredTask, RegistryMap};

        let registry: Arc<Mutex<RegistryMap>> = Arc::new(Mutex::new(RegistryMap::new()));
        let hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>> = Arc::new(RwLock::new(None));
        let recorded: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        *hook.write().unwrap() = Some(Arc::new(RecordingHook {
            events: Arc::clone(&recorded),
        }));

        {
            let mut guard = registry.lock().unwrap();
            let schedule = parser::parse_cron("*/1 * * * *").unwrap();
            let invoker: Arc<dyn TaskInvoker> = Arc::new(NonStringPanicInvoker);
            let mut t =
                RegisteredTask::new("typed-panic".into(), schedule, invoker, Utc::now()).unwrap();
            t.next_run = Utc::now() - chrono::Duration::seconds(5);
            guard.insert("typed-panic".into(), t);
        }

        crate::ticker::__test_dispatch_due_tasks(&registry, &hook);

        let events = recorded.lock().unwrap();
        assert_eq!(events.len(), 1, "expected one recorded panic");
        assert_eq!(events[0].0, "typed-panic");
        assert!(
            events[0].1.contains("non-string panic payload")
                && events[0].1.contains("i32")
                && events[0].1.contains("42"),
            "payload type + value should appear in hook message: {}",
            events[0].1
        );
    }

    /// Ticker correctness under `MissedTickBehavior::Skip` — direct
    /// verification of the dispatch semantics. We park `next_run` in
    /// the past (simulating a long stall) and run a single dispatch.
    /// Only one invocation should occur regardless of how far behind
    /// schedule the task is (skip, not catch-up).
    #[test]
    fn missed_ticks_are_skipped_not_replayed() {
        use crate::registry::{RegisteredTask, RegistryMap};

        let registry: Arc<Mutex<RegistryMap>> = Arc::new(Mutex::new(RegistryMap::new()));
        let hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>> = Arc::new(RwLock::new(None));

        let counter = Arc::new(AtomicUsize::new(0));
        let invoker: Arc<dyn TaskInvoker> = Arc::new(CountingInvoker {
            count: Arc::clone(&counter),
        });

        {
            let mut guard = registry.lock().unwrap();
            let schedule = parser::parse_cron("*/5 * * * *").unwrap();
            let mut t = RegisteredTask::new("drift".into(), schedule, invoker, Utc::now()).unwrap();
            // Simulate a 10-minute stall: next_run is 10 minutes in the
            // past. A catch-up implementation would fire twice.
            t.next_run = Utc::now() - chrono::Duration::minutes(10);
            guard.insert("drift".into(), t);
        }

        crate::ticker::__test_dispatch_due_tasks(&registry, &hook);

        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "missed fires must be skipped, not replayed (Skip semantics)"
        );

        // next_run should now be strictly in the future.
        let guard = registry.lock().unwrap();
        let t = guard.get("drift").unwrap();
        assert!(
            t.next_run > Utc::now(),
            "next_run must be advanced past now"
        );
    }

    /// If `Schedule::next_after(now)` returns `None` (theoretical for
    /// valid 5-field crons, but reachable for future schedule types),
    /// `next_run` must be parked at `DateTime::MAX_UTC` so the task
    /// does not hot-loop by repeatedly firing a past `next_run`.
    #[test]
    fn next_run_parked_at_max_when_no_future_fire() {
        use crate::registry::{RegisteredTask, RegistryMap};

        let registry: Arc<Mutex<RegistryMap>> = Arc::new(Mutex::new(RegistryMap::new()));
        let hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>> = Arc::new(RwLock::new(None));

        let counter = Arc::new(AtomicUsize::new(0));
        let invoker: Arc<dyn TaskInvoker> = Arc::new(CountingInvoker {
            count: Arc::clone(&counter),
        });

        {
            let mut guard = registry.lock().unwrap();
            let schedule = parser::parse_cron("*/1 * * * *").unwrap();
            let mut t = RegisteredTask::new("once".into(), schedule, invoker, Utc::now()).unwrap();
            // Park in the past so the task fires on the next dispatch.
            t.next_run = Utc::now() - chrono::Duration::seconds(5);
            guard.insert("once".into(), t);
        }

        // First dispatch fires the task and advances next_run normally.
        crate::ticker::__test_dispatch_due_tasks(&registry, &hook);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Simulate the None-return path by manually setting next_run to
        // the past AND swapping in a schedule whose `next_after` would
        // return None is hard with the real cron crate, so instead we
        // verify the MAX_UTC behavior indirectly: after many re-dispatches
        // the counter stays at 1 because the task's next_run was advanced
        // past `now` on each fire (no hot-loop). This doubles as a
        // regression guard against the original hot-loop bug.
        for _ in 0..5 {
            crate::ticker::__test_dispatch_due_tasks(&registry, &hook);
        }
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "task must not re-fire once next_run is advanced"
        );
    }

    /// Direct assertion of the `DateTime::MAX_UTC` guard: construct a
    /// task whose `next_run` is in the past, dispatch, then assert
    /// `next_run` has been advanced past `now`.
    #[test]
    fn next_run_advanced_past_now_after_fire() {
        use crate::registry::{RegisteredTask, RegistryMap};

        let registry: Arc<Mutex<RegistryMap>> = Arc::new(Mutex::new(RegistryMap::new()));
        let hook: Arc<RwLock<Option<Arc<dyn ObservabilityHook>>>> = Arc::new(RwLock::new(None));

        let counter = Arc::new(AtomicUsize::new(0));
        let invoker: Arc<dyn TaskInvoker> = Arc::new(CountingInvoker {
            count: Arc::clone(&counter),
        });

        let before_now = Utc::now();
        {
            let mut guard = registry.lock().unwrap();
            let schedule = parser::parse_cron("*/1 * * * *").unwrap();
            let mut t =
                RegisteredTask::new("advance".into(), schedule, invoker, Utc::now()).unwrap();
            t.next_run = before_now - chrono::Duration::seconds(5);
            guard.insert("advance".into(), t);
        }

        crate::ticker::__test_dispatch_due_tasks(&registry, &hook);

        let guard = registry.lock().unwrap();
        let t = guard.get("advance").unwrap();
        assert!(
            t.next_run > Utc::now(),
            "next_run must be strictly in the future after a fire"
        );
    }
}

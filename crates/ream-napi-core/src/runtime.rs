//! Shared Tokio runtime for all NAPI crates.
//!
//! All Ream NAPI bindings share a single Tokio multi-thread runtime
//! instead of each creating their own. This reduces thread overhead
//! and enables cross-crate async coordination.
//!
//! @implements PERF-3

use std::sync::OnceLock;
use tokio::runtime::Runtime;

static SHARED_RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// Get or create the shared Tokio runtime.
///
/// Uses the number of CPU cores as worker threads.
/// Thread-safe: OnceLock ensures single initialization.
pub fn shared_runtime() -> &'static Runtime {
    SHARED_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(num_cpus())
            .enable_all()
            .thread_name("ream-worker")
            .build()
            .expect("Failed to create shared Tokio runtime")
    })
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shared_runtime_returns_same_instance() {
        let rt1 = shared_runtime();
        let rt2 = shared_runtime();
        // Same pointer — OnceLock guarantees single init
        assert!(std::ptr::eq(rt1, rt2));
    }

    #[test]
    fn test_shared_runtime_can_spawn() {
        let rt = shared_runtime();
        let result = rt.block_on(async { 42 });
        assert_eq!(result, 42);
    }
}

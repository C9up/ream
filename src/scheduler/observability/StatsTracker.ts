/**
 * Per-task run statistics. Populated by the scheduler's invocation
 * wrapper and surfaced via `Scheduler.getStats(taskName)`.
 *
 * `nextRunMs` is NOT tracked here — it is read live from the Rust
 * NAPI layer every time `Scheduler.getStats` is called. This tracker
 * only owns counters that accumulate over time.
 *
 * @implements Story 28.4
 */

export interface TaskStats {
  /** ms-epoch of the most recent fire that the wrapper STARTED (lock-skipped fires do not update this). `null` if never started. */
  lastRunMs: number | null
  /** ms-epoch of the next scheduled fire as reported by the Rust core. `null` when the task is unknown or the core returns null. */
  nextRunMs: number | null
  /** Total terminal invocations: completed + failed + skipped. */
  runCount: number
  /** Completed (callback resolved without throwing). */
  successCount: number
  /** Failed (callback threw / rejected). */
  errorCount: number
  /** Skipped (lock backend reported the task already held by another instance). */
  skippedCount: number
  /**
   * Rolling average wall-clock duration over completed + failed
   * runs (skipped runs have no duration and are excluded). `0`
   * until at least one duration has been recorded.
   */
  avgDurationMs: number
}

interface InternalStats {
  lastRunMs: number | null
  runCount: number
  successCount: number
  errorCount: number
  skippedCount: number
  totalDurationMs: number
  durationRunCount: number
}

function zeroInternal(): InternalStats {
  return {
    lastRunMs: null,
    runCount: 0,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
    totalDurationMs: 0,
    durationRunCount: 0,
  }
}

/**
 * O(1) in-memory counter map — one entry per task name seen. Never
 * grows beyond the number of distinct task names the scheduler has
 * seen; no per-run history retained.
 */
export class StatsTracker {
  #stats = new Map<string, InternalStats>()

  #ensure(name: string): InternalStats {
    let s = this.#stats.get(name)
    if (!s) {
      s = zeroInternal()
      this.#stats.set(name, s)
    }
    return s
  }

  recordStarted(name: string, startedAtMs: number): void {
    this.#ensure(name).lastRunMs = startedAtMs
  }

  recordCompleted(name: string, durationMs: number): void {
    const s = this.#ensure(name)
    s.runCount++
    s.successCount++
    // Guard against non-finite durations — a caller bug passing NaN or
    // Infinity would permanently poison the rolling average. Still
    // count the run; only skip the duration accumulation.
    if (Number.isFinite(durationMs)) {
      s.totalDurationMs += durationMs
      s.durationRunCount++
    }
  }

  recordFailed(name: string, durationMs: number): void {
    const s = this.#ensure(name)
    s.runCount++
    s.errorCount++
    if (Number.isFinite(durationMs)) {
      s.totalDurationMs += durationMs
      s.durationRunCount++
    }
  }

  recordSkipped(name: string): void {
    const s = this.#ensure(name)
    s.runCount++
    s.skippedCount++
  }

  /**
   * Return a defensive snapshot. Unknown tasks yield a zeroed
   * snapshot with `null` timestamps. `nextRunMs` is always `null`
   * here — the caller (`Scheduler.getStats`) overlays the live
   * value from the NAPI layer.
   */
  get(name: string): TaskStats {
    const s = this.#stats.get(name)
    if (!s) {
      return {
        lastRunMs: null,
        nextRunMs: null,
        runCount: 0,
        successCount: 0,
        errorCount: 0,
        skippedCount: 0,
        avgDurationMs: 0,
      }
    }
    return {
      lastRunMs: s.lastRunMs,
      nextRunMs: null,
      runCount: s.runCount,
      successCount: s.successCount,
      errorCount: s.errorCount,
      skippedCount: s.skippedCount,
      avgDurationMs: s.durationRunCount > 0 ? s.totalDurationMs / s.durationRunCount : 0,
    }
  }
}

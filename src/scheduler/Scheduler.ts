/**
 * `Scheduler` — thin TypeScript wrapper around `ream-scheduler-napi`.
 *
 * The actual cron parser, task registry, and tick loop live in Rust
 * (Story 28.1). This class:
 *   - Lazily loads the NAPI `.node` binary on first instantiation.
 *   - Adapts the native surface to a typed TS API.
 *   - Translates `napi::Error` JSON payloads into `ReamError`.
 *   - Tracks registered cron expressions locally so `listTasks()` can
 *     return them (the Rust side does not expose task metadata today).
 *
 * @implements Story 28.2
 */

import { performance } from 'node:perf_hooks'
import { ReamError } from '../errors/ReamError.js'
import { loadNapi } from '../helpers/napi-loader.js'
import type { LockBackend } from './locks/LockBackend.js'
import type { ErrorReporter } from './observability/ErrorReporter.js'
import type { ScheduleEvent } from './observability/ScheduleEvent.js'
import type { ScheduleEventSink } from './observability/ScheduleEventSink.js'
import type { TaskStats } from './observability/StatsTracker.js'
import { StatsTracker } from './observability/StatsTracker.js'

/** Payload delivered to every task invocation by the Rust ticker. */
export interface ScheduleInvocation {
  taskName: string
  scheduledForMs: number
}

/** Task listing entry returned by {@link Scheduler.listTasks}. */
export interface TaskInfo {
  name: string
  cronExpr: string
  nextRun: number | null
}

/**
 * Outcome returned by {@link Scheduler.runTaskNow}.
 *
 * - `completed` — the task body resolved without throwing.
 * - `failed` — the task body threw / rejected; `error` carries a
 *   plain-object projection of the throw. Also used when an optional
 *   `timeoutMs` elapses before the task resolves.
 * - `unknown` — no task is registered under the given name;
 *   `durationMs` is `0` and no events are emitted. The `errorReporter`
 *   (if configured) receives a synthetic error so the operator typo
 *   is observable in audit pipelines.
 * - `already-running` — an in-process invocation of the same task is
 *   already in flight; this call was dropped to avoid double-execution.
 *   A `schedule.task.skipped` event with reason `'already-running'`
 *   was emitted.
 */
export interface RunTaskOutcome {
  outcome: 'completed' | 'failed' | 'unknown' | 'already-running'
  durationMs: number
  error?: { name: string; message: string; stack?: string }
}

/** Options accepted by {@link Scheduler.runTaskNow}. */
export interface RunTaskOptions {
  /**
   * Cancel the on-demand run after `timeoutMs` milliseconds. On
   * timeout, `runTaskNow` returns `{ outcome: 'failed', error: ... }`
   * with a `E_SCHEDULE_TASK_TIMEOUT` error. The user callback continues
   * running in the background — JavaScript does not support
   * pre-emptive cancellation; the timeout is observational only.
   */
  timeoutMs?: number
}

/** Shape of the native class exposed by `ream-scheduler-napi`. */
interface NativeScheduler {
  register(
    name: string,
    cronExpr: string,
    callback: (payload: ScheduleInvocation) => void | Promise<void>,
  ): void
  unregister(name: string): void
  start(): void
  stop(): void
  nextRun(name: string): number | null
}

interface NativeModule {
  RustScheduler: new () => NativeScheduler
}

/**
 * Constructor options for {@link Scheduler}.
 */
export interface SchedulerOptions {
  /**
   * Inject a pre-loaded NAPI module. Intended for tests that bypass
   * the `.node` binary lookup — production callers should omit this
   * and let `loadNapi` resolve the platform-suffixed binary.
   */
  nativeModule?: NativeModule
  /**
   * Distributed-lock backend. When provided, every task invocation
   * is guarded by `acquire(name, defaultLockTtlMs)` / `release(name)`
   * so horizontally-scaled deployments do not double-execute.
   * Defaults to `undefined` (no locking — single-instance semantics).
   */
  lockBackend?: LockBackend
  /**
   * Lock TTL in milliseconds. Defaults to 60_000 (one minute). Only
   * used when `lockBackend` is provided.
   */
  defaultLockTtlMs?: number
  /**
   * Destination for task-invocation events
   * (`schedule.task.{started,completed,failed,skipped}`). Leave
   * undefined to disable event emission — stats tracking still
   * happens regardless, and `getStats` remains useful.
   */
  eventSink?: ScheduleEventSink
  /**
   * Callback invoked when a task throws. Typically bridges to
   * `ErrorBoundary.serviceError`. Leave undefined to disable
   * boundary reporting.
   */
  errorReporter?: ErrorReporter
}

const DEFAULT_LOCK_TTL_MS = 60_000

let native: NativeModule | undefined

function loadNative(): NativeModule {
  if (native) return native
  native = loadNapi<NativeModule>({
    binaryName: 'scheduler',
    callerMetaUrl: import.meta.url,
    errorCodePrefix: 'SCHEDULER',
  })
  return native
}

/**
 * Convert a thrown native error into a `ReamError`. Prefers parsing the
 * JSON payload shipped by Rust (`ream_napi_core::ReamError::into()`);
 * falls back to wrapping opaque errors under `E_SCHEDULER_NATIVE_ERROR`
 * so scheduler context is never lost.
 */
function translateNativeError(e: unknown): ReamError {
  const asError = e as Error
  const parsed = ReamError.fromNapi(asError)
  // `fromNapi` returns an `E_UNKNOWN`-coded error when the message is not
  // a JSON payload. Preserve that context under a scheduler-specific
  // code so callers can trace the failure back to this layer.
  if (parsed.code === 'E_UNKNOWN') {
    return new ReamError(
      'E_SCHEDULER_NATIVE_ERROR',
      `ream-scheduler NAPI call failed: ${asError.message}`,
      {
        hint: 'This is likely a bug in the scheduler. Please file an issue with the stack trace.',
      },
    )
  }
  return parsed
}

/**
 * Cron-style scheduler backed by a Rust Tokio ticker.
 *
 * ```ts
 * const scheduler = new Scheduler()
 * scheduler.register('cleanup', '0 *\/5 * * *', () => { ... })
 * scheduler.start()
 * // later
 * scheduler.stop()
 * ```
 *
 * All schedules evaluate in UTC. Missed fires after a runtime stall are
 * dropped, not replayed (see `ream-scheduler` crate docs).
 */
export class Scheduler {
  #inner: NativeScheduler
  /** Mirror of registrations — Rust does not expose this today. */
  #tasks = new Map<
    string,
    {
      cronExpr: string
      /** The user's raw callback — `runTaskNow` calls this directly
       *  via {@link Scheduler.#runOnce} so the admin-override path
       *  bypasses the lock backend but still runs through the shared
       *  observability core (events + stats + reporter). */
      callback: (payload: ScheduleInvocation) => void | Promise<void>
    }
  >()
  #lockBackend: LockBackend | null
  #defaultLockTtlMs: number
  #eventSink: ScheduleEventSink | null
  #errorReporter: ErrorReporter | null
  #stats = new StatsTracker()
  /** Set of task names currently in flight — prevents concurrent
   *  double-execution when the ticker and `runTaskNow` (or two
   *  simultaneous `runTaskNow` calls) collide on the same name. */
  #running = new Set<string>()

  constructor(options: SchedulerOptions = {}) {
    if (options.lockBackend !== undefined) {
      const be = options.lockBackend as Partial<LockBackend>
      if (typeof be.acquire !== 'function' || typeof be.release !== 'function') {
        throw new ReamError(
          'E_SCHEDULE_INVALID_LOCK_BACKEND',
          'Scheduler options.lockBackend must implement acquire(name, ttlMs) and release(name)',
        )
      }
    }
    if (options.defaultLockTtlMs !== undefined) {
      if (!Number.isFinite(options.defaultLockTtlMs) || options.defaultLockTtlMs <= 0) {
        throw new ReamError(
          'E_SCHEDULE_INVALID_LOCK_TTL',
          `Scheduler options.defaultLockTtlMs must be a finite positive number, got ${options.defaultLockTtlMs}`,
          {
            hint: 'Use a millisecond value greater than zero (typical range 1_000 – 600_000).',
          },
        )
      }
    }
    if (options.eventSink !== undefined) {
      const sink = options.eventSink as Partial<ScheduleEventSink>
      if (typeof sink.emit !== 'function') {
        throw new ReamError(
          'E_SCHEDULE_INVALID_EVENT_SINK',
          'Scheduler options.eventSink must implement emit(event)',
        )
      }
    }
    if (options.errorReporter !== undefined && typeof options.errorReporter !== 'function') {
      throw new ReamError(
        'E_SCHEDULE_INVALID_ERROR_REPORTER',
        'Scheduler options.errorReporter must be a function',
      )
    }
    const mod = options.nativeModule ?? loadNative()
    this.#inner = new mod.RustScheduler()
    this.#lockBackend = options.lockBackend ?? null
    this.#defaultLockTtlMs = options.defaultLockTtlMs ?? DEFAULT_LOCK_TTL_MS
    this.#eventSink = options.eventSink ?? null
    this.#errorReporter = options.errorReporter ?? null
  }

  #emit(event: ScheduleEvent): void {
    if (!this.#eventSink) return
    try {
      const result = this.#eventSink.emit(event)
      // Detect a thenable and swallow any async rejection so the
      // ticker cannot be crashed by a buggy async adapter. Use the
      // `.then`-based detection + `Promise.resolve` wrap so non-native
      // thenables (e.g. RxJS-style) are handled uniformly.
      if (
        // Object OR function: a thenable function is exotic but legal, and the
        // guard this replaced accepted one. `in` narrows either.
        (typeof result === 'object' || typeof result === 'function') &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Swallow — a buggy sink adapter must not kill the ticker.
    }
  }

  /**
   * Shared observability core: emit started, invoke the callback,
   * emit completed/failed, record stats, forward to the error
   * reporter. Returns the terminal outcome so callers (the ticker
   * wrapped closure and `runTaskNow`) can act on the result without
   * re-reading the stats map.
   *
   * Does NOT touch the lock backend — lock handling is the caller's
   * responsibility so the admin-override path can bypass it cleanly.
   */
  async #runOnce(
    name: string,
    callback: (payload: ScheduleInvocation) => void | Promise<void>,
    scheduledForMs: number,
  ): Promise<
    | { outcome: 'completed' | 'failed'; durationMs: number; error?: Error }
    | { outcome: 'already-running'; durationMs: 0 }
  > {
    // Concurrent-execution guard. The distributed lock prevents
    // double-fire across instances; this Set prevents double-fire
    // WITHIN a single process (ticker racing with runTaskNow, or two
    // operators hitting runTaskNow at once). A duplicate invocation
    // is recorded as a skip with reason `'already-running'`.
    if (this.#running.has(name)) {
      this.#stats.recordSkipped(name)
      this.#emit({ type: 'schedule.task.skipped', taskName: name, reason: 'already-running' })
      return { outcome: 'already-running', durationMs: 0 }
    }
    this.#running.add(name)
    const startedAt = Date.now()
    const perfStart = performance.now()
    this.#stats.recordStarted(name, startedAt)
    this.#emit({
      type: 'schedule.task.started',
      taskName: name,
      scheduledForMs,
      startedAtMs: startedAt,
    })
    try {
      await callback({ taskName: name, scheduledForMs })
      const durationMs = performance.now() - perfStart
      this.#stats.recordCompleted(name, durationMs)
      this.#emit({ type: 'schedule.task.completed', taskName: name, durationMs })
      return { outcome: 'completed', durationMs }
    } catch (err) {
      const durationMs = performance.now() - perfStart
      this.#stats.recordFailed(name, durationMs)
      const errObj = err instanceof Error ? err : new Error(String(err))
      this.#emit({
        type: 'schedule.task.failed',
        taskName: name,
        error: { name: errObj.name, message: errObj.message, stack: errObj.stack },
        durationMs,
      })
      this.#report(err, name)
      return { outcome: 'failed', durationMs, error: errObj }
    } finally {
      this.#running.delete(name)
    }
  }

  #report(err: unknown, taskName: string): void {
    if (!this.#errorReporter) return
    try {
      // The `ErrorReporter` type declares `void` return, but a user
      // adapter that declares an `async` function still satisfies the
      // callable shape and will return a Promise at runtime. Swallow
      // any async rejection in addition to sync throws so a bad
      // reporter never crashes the ticker.
      const result = this.#errorReporter(err, { taskName }) as unknown
      if (
        // Object OR function: a thenable function is exotic but legal, and the
        // guard this replaced accepted one. `in` narrows either.
        (typeof result === 'object' || typeof result === 'function') &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Swallow — a reporter that itself throws cannot propagate.
    }
  }

  /**
   * Register a recurring task.
   *
   * The callback is invoked by the Rust ticker when the cron schedule
   * fires. Exceptions thrown synchronously or rejected asynchronously
   * are caught here so they never surface back to the Rust side; when
   * an `eventSink` / `errorReporter` is configured, failures are
   * emitted as `schedule.task.failed` events and forwarded to the
   * reporter. Otherwise the error is dropped silently.
   *
   * Event ordering guarantees: within a single tick, events are emitted
   * in the documented order (`started` → `completed` | `failed` |
   * `skipped`). Ordering across ticks is NOT guaranteed when the sink
   * returns a Promise — the scheduler does not chain sink promises, so
   * a fast tick N+1 can deliver events before a slow tick N's events
   * reach the sink. Sinks that need strict ordering should maintain
   * their own sequencing.
   */
  register(
    name: string,
    cronExpr: string,
    callback: (payload: ScheduleInvocation) => void | Promise<void>,
  ): void {
    if (typeof callback !== 'function') {
      throw new ReamError(
        'E_SCHEDULE_INVALID_CALLBACK',
        `Scheduler.register expected a function callback for task '${name}', got ${typeof callback}`,
      )
    }
    if (name === '') {
      throw new ReamError(
        'E_SCHEDULE_INVALID_TASK_NAME',
        'Scheduler.register requires a non-empty task name',
      )
    }
    // Capture-at-register: the active lock backend is frozen per-task
    // at registration time (observability sinks are read live via
    // #runOnce so they can be replaced in the future non-breakingly).
    const lockBackend = this.#lockBackend
    const lockTtlMs = this.#defaultLockTtlMs

    // Wrapped closure delegated to #runOnce for the observability
    // core — lock handling layered around it when a backend is
    // configured. `runTaskNow` reuses `#runOnce` directly, bypassing
    // the lock.
    const wrapped = async (payload: ScheduleInvocation): Promise<void> => {
      if (lockBackend !== null) {
        let acquired: boolean
        try {
          acquired = await lockBackend.acquire(name, lockTtlMs)
        } catch (acquireErr) {
          this.#stats.recordSkipped(name)
          this.#emit({
            type: 'schedule.task.skipped',
            taskName: name,
            reason: 'acquire-failed',
          })
          this.#report(acquireErr, name)
          return
        }
        if (!acquired) {
          this.#stats.recordSkipped(name)
          this.#emit({ type: 'schedule.task.skipped', taskName: name, reason: 'locked' })
          return
        }
      }
      try {
        await this.#runOnce(name, callback, payload.scheduledForMs)
      } finally {
        if (lockBackend !== null) {
          try {
            await lockBackend.release(name)
          } catch {
            // Swallow — lock auto-frees via TTL.
          }
        }
      }
    }
    try {
      this.#inner.register(name, cronExpr, wrapped)
    } catch (e) {
      throw translateNativeError(e)
    }
    this.#tasks.set(name, { cronExpr, callback })
  }

  /**
   * Remove a registered task. Idempotent — unknown names are not an
   * error. If the native side reports an unknown-task condition it is
   * treated as already-removed rather than propagated.
   */
  unregister(name: string): void {
    try {
      this.#inner.unregister(name)
    } catch (e) {
      const err = translateNativeError(e)
      // Rust's `unregister` is itself idempotent (Story 28.1) so a
      // thrown error here is unexpected. Drop the local entry anyway
      // — the doc promises idempotence — but surface any unexpected
      // native failure that is not a missing-task situation.
      if (err.code !== 'UNKNOWN_TASK' && err.code !== 'E_SCHEDULER_NATIVE_ERROR') {
        this.#tasks.delete(name)
        throw err
      }
    }
    this.#tasks.delete(name)
  }

  /**
   * Start the Rust ticker. Safe to call when already running — the
   * underlying `ream-scheduler` core is idempotent (Story 28.1: the
   * ticker's internal cancel channel is only installed once per start).
   */
  start(): void {
    try {
      this.#inner.start()
    } catch (e) {
      throw translateNativeError(e)
    }
  }

  /**
   * Cancel the Rust ticker. Safe to call when not running — the
   * underlying `ream-scheduler` core treats `stop()` as a no-op when no
   * cancel channel is installed.
   */
  stop(): void {
    try {
      this.#inner.stop()
    } catch (e) {
      throw translateNativeError(e)
    }
  }

  /**
   * Return the next fire time in ms since epoch, or `null` if the task
   * is unknown.
   */
  nextRun(name: string): number | null {
    try {
      return this.#inner.nextRun(name)
    } catch (e) {
      throw translateNativeError(e)
    }
  }

  /**
   * Snapshot of every currently-registered task.
   *
   * NOTE: Makes one FFI call per task via `nextRun`. Acceptable for
   * typical task counts (dozens); consumers iterating huge registries
   * should cache the result.
   */
  listTasks(): TaskInfo[] {
    const out: TaskInfo[] = []
    for (const [name, { cronExpr }] of this.#tasks) {
      out.push({ name, cronExpr, nextRun: this.nextRun(name) })
    }
    return out
  }

  /**
   * Invoke a registered task once immediately, bypassing the cron
   * schedule AND the configured lock backend.
   *
   * **Admin override:** `runTaskNow` does NOT consult the
   * `lockBackend`. Running a task manually is an explicit operator
   * action that must not be blocked by a peer instance holding the
   * distributed lock. Regular ticker-driven fires continue to honor
   * the lock.
   *
   * Observability is preserved — the same `started` / `completed`
   * / `failed` events fire and the `errorReporter` runs exactly as
   * for a normal tick, updating `getStats(name)` identically.
   *
   * Unknown task names return `{ outcome: 'unknown', durationMs: 0 }`
   * without emitting any event — mirrors the never-throws contract
   * of {@link Scheduler.getStats}.
   */
  async runTaskNow(name: string, options: RunTaskOptions = {}): Promise<RunTaskOutcome> {
    const entry = this.#tasks.get(name)
    if (!entry) {
      // Notify the observability boundary so operator typos leave a
      // trace. No event is emitted — events are reserved for
      // real task invocations.
      this.#report(
        new ReamError(
          'E_SCHEDULE_TASK_UNKNOWN',
          `runTaskNow called with unknown task name: '${name}'`,
        ),
        name,
      )
      return { outcome: 'unknown', durationMs: 0 }
    }

    const runPromise = this.#runOnce(name, entry.callback, Date.now())

    // Optional timeout: whichever wins, runPromise stays running in
    // the background — JS has no pre-emptive cancellation.
    const result =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? await Promise.race([
            runPromise,
            new Promise<{ outcome: 'failed'; durationMs: number; error: Error }>((resolve) => {
              setTimeout(() => {
                resolve({
                  outcome: 'failed',
                  durationMs: options.timeoutMs ?? 0,
                  error: new ReamError(
                    'E_SCHEDULE_TASK_TIMEOUT',
                    `Task '${name}' did not complete within ${options.timeoutMs} ms (background execution continues)`,
                  ),
                })
              }, options.timeoutMs)
            }),
          ])
        : await runPromise

    if (result.outcome === 'already-running') {
      return { outcome: 'already-running', durationMs: 0 }
    }
    if (result.outcome === 'failed') {
      return {
        outcome: 'failed',
        durationMs: result.durationMs,
        error: {
          name: result.error?.name ?? 'Error',
          message: result.error?.message ?? 'unknown error',
          stack: result.error?.stack,
        },
      }
    }
    return { outcome: 'completed', durationMs: result.durationMs }
  }

  /**
   * Return a snapshot of observability counters for `taskName`.
   *
   * Unknown task names return a zeroed snapshot (all counters `0`,
   * all timestamps `null`) — never throws. The `nextRunMs` field is
   * read live from the Rust layer on each call; a native-side failure
   * is swallowed here so that `getStats` always returns.
   */
  getStats(taskName: string): TaskStats {
    const snapshot = this.#stats.get(taskName)
    let nextRunMs: number | null = null
    try {
      nextRunMs = this.nextRun(taskName)
    } catch {
      // Swallow — getStats guarantees no-throw.
    }
    return { ...snapshot, nextRunMs }
  }
}

/**
 * Discriminated union of events emitted by the scheduler's task
 * invocation wrapper.
 *
 * All payloads are JSON-serializable so downstream sinks (the event bus,
 * structured logs, metrics backends) can forward them without
 * touching live `Error` instances.
 *
 * @implements Story 28.4
 */

export interface ScheduleTaskStartedEvent {
  type: 'schedule.task.started'
  taskName: string
  /** ms-epoch instant the Rust ticker chose for this fire. */
  scheduledForMs: number
  /** ms-epoch at which the JS wrapper began running the user callback. */
  startedAtMs: number
}

export interface ScheduleTaskCompletedEvent {
  type: 'schedule.task.completed'
  taskName: string
  /** Wall-clock milliseconds spent running the callback. */
  durationMs: number
}

export interface ScheduleTaskFailedEvent {
  type: 'schedule.task.failed'
  taskName: string
  /** Plain-object projection of the thrown error (no live `Error`). */
  error: { name: string; message: string; stack?: string }
  /** Wall-clock milliseconds until the throw. */
  durationMs: number
}

export interface ScheduleTaskSkippedEvent {
  type: 'schedule.task.skipped'
  taskName: string
  /** Reason this tick did not execute the task body.
   *  - `'locked'` — distributed-lock backend reported the slot as
   *    already held by another instance.
   *  - `'acquire-failed'` — the lock backend itself threw/rejected
   *    (e.g. Redis connection drop); the scheduler treats the tick
   *    as skipped for observability rather than silently dropping.
   *  - `'already-running'` — an in-process invocation of the same
   *    task is already in flight (ticker + concurrent `runTaskNow`,
   *    or two simultaneous `runTaskNow` calls). The duplicate is
   *    dropped to prevent double-execution of non-idempotent tasks.
   *
   *  Left open for future reasons (e.g. `'paused'`). Consumers that
   *  branch on `reason` should handle unknown values defensively
   *  (log + treat as skip) so adding a new variant is non-breaking. */
  reason: 'locked' | 'acquire-failed' | 'already-running'
}

export type ScheduleEvent =
  | ScheduleTaskStartedEvent
  | ScheduleTaskCompletedEvent
  | ScheduleTaskFailedEvent
  | ScheduleTaskSkippedEvent

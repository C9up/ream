/**
 * Pluggable distributed-lock interface for the scheduler.
 *
 * The scheduler consults a `LockBackend` immediately before firing a
 * registered task so that in multi-instance deployments only one
 * instance runs a given task on each tick. Redis, database
 * advisory-lock, and other backends live in user-land — this module
 * ships only the interface and a single-process `MemoryLockBackend`.
 *
 * @implements Story 28.3
 */

export interface LockBackend {
  /**
   * Attempt to acquire an exclusive lock on `name` for up to `ttlMs`
   * wall-clock milliseconds.
   *
   * Returns `true` when the caller now owns the lock, `false` when it
   * is held by someone else. Implementations must treat an entry
   * whose TTL has elapsed as free — expired locks auto-recover
   * without manual cleanup, which is essential for crash tolerance.
   *
   * Implementations should be safe to call concurrently; the memory
   * backend serializes access through a synchronous `Map` under the
   * hood, remote backends typically rely on their server's atomic
   * compare-and-set primitive.
   */
  acquire(name: string, ttlMs: number): Promise<boolean>

  /**
   * Release the lock on `name`. Idempotent — releasing an unknown or
   * already-released lock must not throw. The scheduler calls this
   * in a `finally` block immediately after the task completes so the
   * next tick on any instance can re-acquire without waiting for the
   * TTL.
   */
  release(name: string): Promise<void>
}

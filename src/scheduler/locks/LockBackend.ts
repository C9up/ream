/**
 * Pluggable distributed-lock interface for the scheduler.
 *
 * The scheduler consults a `LockBackend` immediately before firing a
 * registered task so that in multi-instance deployments only one
 * instance runs a given task on each tick.
 *
 * Two backends ship with it: `MemoryLockBackend`, correct while the
 * application runs in one process, and `RedisLockBackend`, which is
 * what a second replica needs — see `locks` for the factories a
 * config file names.
 *
 * @implements Story 28.3
 */

import { ReamError } from '../../errors/ReamError.js'

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

/**
 * Reject a TTL that cannot bound anything. A zero or negative lease
 * expires the instant it is taken, so every instance would acquire the
 * same lock and run the same task — the exact outcome locking exists to
 * prevent, arriving silently.
 */
export function assertValidTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ReamError(
      'E_SCHEDULE_INVALID_LOCK_TTL',
      `Lock TTL must be a finite positive number, got ${ttlMs}`,
      {
        hint: 'Use a millisecond value greater than zero (typical range 1_000 - 600_000).',
      },
    )
  }
}

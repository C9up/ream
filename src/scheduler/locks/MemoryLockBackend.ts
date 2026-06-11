/**
 * Default single-process lock backend backed by a `Map`.
 *
 * Correct for apps that run in a single Node.js process. For
 * horizontally-scaled deployments, implement `LockBackend` against a
 * shared store (Redis `SET NX PX`, Postgres advisory locks, etc.) —
 * those drivers live in user-land per the project's "agnostic per
 * package" rule.
 *
 * Expiry is evaluated **lazily** at `acquire` time — no background
 * timer, no `setInterval`. This preserves Story 28.1's
 * Rust-ticker-only philosophy: the only timers in the scheduler live
 * in the Rust Tokio runtime.
 *
 * An opportunistic sweep runs at most once per `acquire` call to
 * cap unbounded growth: when the map exceeds `SWEEP_THRESHOLD`
 * entries, expired entries are pruned in O(N) without blocking
 * the normal path.
 *
 * @implements Story 28.3
 */

import { ReamError } from '../../errors/ReamError.js'
import type { LockBackend } from './LockBackend.js'

const SWEEP_THRESHOLD = 256

function assertValidTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ReamError(
      'SCHEDULE_INVALID_LOCK_TTL',
      `Lock TTL must be a finite positive number, got ${ttlMs}`,
      {
        hint: 'Use a millisecond value greater than zero (typical range 1_000 – 600_000).',
      },
    )
  }
}

export class MemoryLockBackend implements LockBackend {
  #locks = new Map<string, number>()

  async acquire(name: string, ttlMs: number): Promise<boolean> {
    assertValidTtl(ttlMs)
    const now = Date.now()

    // Opportunistic sweep: when the map grows past the threshold,
    // drop expired entries. Bounded by the current map size, runs at
    // most once per acquire, never schedules async work.
    if (this.#locks.size >= SWEEP_THRESHOLD) {
      for (const [key, expiry] of this.#locks) {
        if (expiry <= now) this.#locks.delete(key)
      }
    }

    const existing = this.#locks.get(name)
    if (existing !== undefined && existing > now) {
      return false
    }
    this.#locks.set(name, now + ttlMs)
    return true
  }

  async release(name: string): Promise<void> {
    this.#locks.delete(name)
  }

  /**
   * @internal Test-only helper: force an entry into the map with an
   * arbitrary expiry. Used to simulate a crashed holder whose lock
   * has already expired without advancing `Date.now()`. Not part of
   * the public {@link LockBackend} contract — never call from
   * production code.
   */
  __setExpiryForTesting(name: string, expiryMs: number): void {
    this.#locks.set(name, expiryMs)
  }

  /** @internal Test-only helper — return the current map size. */
  __sizeForTesting(): number {
    return this.#locks.size
  }
}


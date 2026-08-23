import type { SessionDriver } from '../Session.js'

/** Sweep expired entries once the store reaches this size. */
const SWEEP_THRESHOLD = 1000

/**
 * Hard cap on live sessions.
 *
 * The sweep alone only removes EXPIRED entries, so within the TTL window
 * nothing bounded growth: anyone able to request a page could mint sessions
 * until the process ran out of memory, without ever logging in. Past the cap
 * the oldest sessions are dropped — a bounded store that forgets is strictly
 * better than an unbounded one that dies.
 */
const DEFAULT_MAX_ENTRIES = 10_000

export interface MemoryDriverOptions {
  /** Maximum live sessions kept in memory. Default 10 000. */
  maxEntries?: number
}

export class MemoryDriver implements SessionDriver {
  #store: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map()
  readonly #maxEntries: number

  constructor(options: MemoryDriverOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  }

  async read(sessionId: string): Promise<Record<string, unknown>> {
    const entry = this.#store.get(sessionId)
    if (!entry || entry.expiresAt < Date.now()) {
      this.#store.delete(sessionId)
      return {}
    }
    return { ...entry.data }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    if (this.#store.size >= SWEEP_THRESHOLD) {
      const now = Date.now()
      for (const [id, entry] of this.#store) {
        if (entry.expiresAt < now) this.#store.delete(id)
      }
    }
    // Re-inserting moves the key to the end, so eviction order stays "oldest
    // written first" rather than "oldest ever seen".
    this.#store.delete(sessionId)
    this.#store.set(sessionId, { data, expiresAt: Date.now() + ttl * 1000 })
    // Sweeping may have freed nothing — every session can be live and unexpired.
    while (this.#store.size > this.#maxEntries) {
      const oldest = this.#store.keys().next()
      if (oldest.done) break
      this.#store.delete(oldest.value)
    }
  }

  async destroy(sessionId: string): Promise<void> {
    this.#store.delete(sessionId)
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    const entry = this.#store.get(sessionId)
    if (entry) {
      entry.expiresAt = Date.now() + ttl * 1000
    }
  }
}

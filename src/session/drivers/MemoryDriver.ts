import type { SessionDriverWithTagging, TaggedSession } from '../Session.js'

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

export class MemoryDriver implements SessionDriverWithTagging {
  #store: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map()
  /** user id → the sessions tagged with it. */
  #tags: Map<string, Set<string>> = new Map()
  readonly #maxEntries: number

  constructor(options: MemoryDriverOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  }

  async read(sessionId: string): Promise<Record<string, unknown> | null> {
    const entry = this.#store.get(sessionId)
    if (!entry || entry.expiresAt < Date.now()) {
      this.#store.delete(sessionId)
      return null
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
    // Drop the tags too: a destroyed session left in the index would be
    // reported as an active device forever.
    for (const [userId, ids] of this.#tags) {
      if (!ids.delete(sessionId)) continue
      if (ids.size === 0) this.#tags.delete(userId)
    }
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    const entry = this.#store.get(sessionId)
    if (entry) {
      entry.expiresAt = Date.now() + ttl * 1000
    }
  }

  async tag(sessionId: string, userId: string | number): Promise<void> {
    const key = String(userId)
    const ids = this.#tags.get(key) ?? new Set<string>()
    ids.add(sessionId)
    this.#tags.set(key, ids)
  }

  async untag(sessionId: string, userId: string | number): Promise<void> {
    const key = String(userId)
    const ids = this.#tags.get(key)
    if (!ids) return
    ids.delete(sessionId)
    if (ids.size === 0) this.#tags.delete(key)
  }

  async tagged(userId: string | number): Promise<TaggedSession[]> {
    const ids = this.#tags.get(String(userId))
    if (!ids) return []
    const now = Date.now()
    const sessions: TaggedSession[] = []
    for (const id of [...ids]) {
      const entry = this.#store.get(id)
      // An expired or evicted session is not an active device. Forget it here
      // too, so the index does not grow with entries the store already lost.
      if (!entry || entry.expiresAt < now) {
        ids.delete(id)
        continue
      }
      sessions.push({ id, data: { ...entry.data } })
    }
    if (ids.size === 0) this.#tags.delete(String(userId))
    return sessions
  }
}

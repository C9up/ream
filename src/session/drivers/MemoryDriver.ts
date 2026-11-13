import type { SessionDriverWithTagging, TaggedSession } from '../Session.js'

/** Sweep expired entries once the store reaches this size. */
const SWEEP_THRESHOLD = 1000

/**
 * At most one sweep per this many milliseconds.
 *
 * A sweep walks the whole store. Run on every write past the threshold, a
 * flood of anonymous requests turned each write into a 10 000-entry scan —
 * quadratic, and 20 000 writes took seconds. Between two sweeps the cap below
 * still bounds the store, and a read drops the expired entry it lands on.
 */
const SWEEP_INTERVAL_MS = 1000

/**
 * Hard cap on live sessions.
 *
 * The sweep alone only removes EXPIRED entries, so within the TTL window
 * nothing bounded growth: anyone able to request a page could mint sessions
 * until the process ran out of memory, without ever logging in. Past the cap
 * the least recently used sessions are dropped (a write, an update or a
 * touch moves a session to the back of the line) — a bounded store that
 * forgets is strictly better than an unbounded one that dies.
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
  /** When the last sweep ran, epoch milliseconds. */
  #lastSweep = 0

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
    const now = Date.now()
    if (this.#store.size >= SWEEP_THRESHOLD && now - this.#lastSweep >= SWEEP_INTERVAL_MS) {
      this.#lastSweep = now
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

  /** Atomic by construction: nothing else runs between the check and the set. */
  async update(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<boolean> {
    const entry = this.#store.get(sessionId)
    if (!entry || entry.expiresAt < Date.now()) return false
    this.#store.delete(sessionId)
    this.#store.set(sessionId, { data, expiresAt: Date.now() + ttl * 1000 })
    return true
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
    if (!entry || entry.expiresAt < Date.now()) return
    // Re-inserted, not updated in place: eviction drops the head of the map,
    // so a session in use has to move to the tail. Updated in place, a
    // signed-in user who keeps browsing stayed first in line, and ten
    // thousand anonymous requests evicted them.
    entry.expiresAt = Date.now() + ttl * 1000
    this.#store.delete(sessionId)
    this.#store.set(sessionId, entry)
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

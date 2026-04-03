/**
 * Session — server-side session management.
 *
 * Like AdonisJS Session:
 *   session.get('key')
 *   session.put('key', value)
 *   session.flash('success', 'Saved!')
 *   session.forget('key')
 *
 * Backed by pluggable drivers (cookie, memory, redis).
 */

export interface SessionDriver {
  read(sessionId: string): Promise<Record<string, unknown>>
  write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void>
  destroy(sessionId: string): Promise<void>
  touch(sessionId: string, ttl: number): Promise<void>
}

export interface SessionConfig {
  driver: string
  cookieName?: string
  maxAge?: number // seconds, default 7200 (2h)
  clearWithBrowser?: boolean
}

export class Session {
  private data: Record<string, unknown> = {}
  private flashData: Record<string, unknown> = {}
  private previousFlash: Record<string, unknown> = {}
  private dirty = false
  readonly sessionId: string

  constructor(sessionId: string, data: Record<string, unknown> = {}) {
    this.sessionId = sessionId
    this.data = { ...data }
    this.previousFlash = (data.__flash ?? {}) as Record<string, unknown>
    delete this.data.__flash
  }

  /** Get a session value. */
  get<T = unknown>(key: string, defaultValue?: T): T {
    if (key in this.data) return this.data[key] as T
    return defaultValue as T
  }

  /** Set a session value. */
  put(key: string, value: unknown): void {
    this.data[key] = value
    this.dirty = true
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return key in this.data
  }

  /** Get all session data. */
  all(): Record<string, unknown> {
    return { ...this.data }
  }

  /** Remove a key. */
  forget(key: string): void {
    delete this.data[key]
    this.dirty = true
  }

  /** Get and remove a key. */
  pull<T = unknown>(key: string, defaultValue?: T): T {
    const value = this.get<T>(key, defaultValue)
    this.forget(key)
    return value
  }

  /** Clear all session data. */
  clear(): void {
    this.data = {}
    this.dirty = true
  }

  /** Increment a numeric value. */
  increment(key: string, amount = 1): void {
    const current = (this.get<number>(key) ?? 0)
    this.put(key, current + amount)
  }

  /** Decrement a numeric value. */
  decrement(key: string, amount = 1): void {
    this.increment(key, -amount)
  }

  // ─── Flash data ───────────────────────────────────────────

  /** Set flash data (available only on the next request). */
  flash(key: string, value: unknown): void {
    this.flashData[key] = value
    this.dirty = true
  }

  /** Flash all current input. */
  flashAll(input: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(input)) {
      this.flashData[k] = v
    }
    this.dirty = true
  }

  /** Flash only specific keys. */
  flashOnly(input: Record<string, unknown>, keys: string[]): void {
    for (const k of keys) {
      if (k in input) this.flashData[k] = input[k]
    }
    this.dirty = true
  }

  /** Flash all except specific keys. */
  flashExcept(input: Record<string, unknown>, keys: string[]): void {
    const keySet = new Set(keys)
    for (const [k, v] of Object.entries(input)) {
      if (!keySet.has(k)) this.flashData[k] = v
    }
    this.dirty = true
  }

  /** Get a flashed value from the previous request. */
  flashMessages(): Record<string, unknown> {
    return { ...this.previousFlash }
  }

  /** Get a specific flash message from the previous request. */
  old<T = unknown>(key: string, defaultValue?: T): T {
    if (key in this.previousFlash) return this.previousFlash[key] as T
    return defaultValue as T
  }

  // ─── Serialization ────────────────────────────────────────

  /** Serialize for storage. Includes flash data for next request. */
  toJSON(): Record<string, unknown> {
    const result = { ...this.data }
    if (Object.keys(this.flashData).length > 0) {
      result.__flash = this.flashData
    }
    return result
  }

  isDirty(): boolean {
    return this.dirty
  }
}

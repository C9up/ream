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

import type { SessionRedisClientSource } from './drivers/RedisDriver.js'

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
  /**
   * When true, re-emit Set-Cookie on every response so the cookie's `maxAge`
   * window slides forward on each request. Active users won't be logged out
   * mid-session; the trade-off is a `Vary: Cookie` side-channel on every
   * response (defeats shared HTTP caches). Default `false` to preserve cache
   * behaviour. Express-session and AdonisJS expose the same toggle.
   */
  rolling?: boolean
  /**
   * `redis` driver only — the quasar connection to store sessions on. Left
   * unset, the default connection is used.
   */
  connection?: string
  /**
   * `redis` driver only — a client to use instead of resolving one through
   * quasar. Anything carrying get/set/del/expire satisfies it, so an app can
   * share the client it already has.
   */
  client?: SessionRedisClientSource
  /** `redis` driver only — key prefix. Defaults to `ream:session:`. */
  prefix?: string
}

/**
 * Generate a fresh session ID. Format mirrors AdonisJS / express-session —
 * 32 bytes of base64url entropy (~256 bits). Defined here so `regenerate()`
 * can pick a new id without bringing in a driver dependency.
 */
function generateSessionId(): string {
  const bytes = new Uint8Array(32)
  // `crypto.getRandomValues` is a Node ≥ 19 builtin AND the standard browser
  // API; same call site works on both runtimes without a polyfill.
  crypto.getRandomValues(bytes)
  let str = ''
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i] ?? 0)
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export class Session {
  #data: Record<string, unknown> = {}
  #flashData: Record<string, unknown> = {}
  #previousFlash: Record<string, unknown> = {}
  #dirty = false
  #sessionId: string
  /**
   * The session id active when the request arrived, captured at construction.
   * The middleware uses this on the way out to migrate driver storage
   * (`driver.write(newId)` + `driver.destroy(oldId)`) when the application
   * called `regenerate()` mid-request.
   */
  readonly #originalSessionId: string
  #regenerated = false

  constructor(sessionId: string, data: Record<string, unknown> = {}) {
    this.#sessionId = sessionId
    this.#originalSessionId = sessionId
    this.#data = { ...data }
    const flash = data.__flash
    this.#previousFlash =
      typeof flash === 'object' && flash !== null && !Array.isArray(flash)
        ? // biome-ignore lint/suspicious/noExplicitAny: flash narrowed to non-null non-array object; branded as Record for key access
          (flash as any as Record<string, unknown>)
        : {}
    delete this.#data.__flash
  }

  /** Current session id. Mutated by `regenerate()`. */
  get sessionId(): string {
    return this.#sessionId
  }

  /**
   * Rotate the session id while preserving the data. The standard mitigation
   * for session-fixation (CWE-384): call this whenever a privilege boundary
   * is crossed — login, role change, sensitive-action confirmation. Warden's
   * `SessionStrategy.login()` calls it automatically before writing the
   * authenticated user id.
   *
   * The new id takes effect inside this Session instance immediately so
   * subsequent `session.get()` / `session.put()` see the same data under
   * the new id. The SessionMiddleware sees `wasRegenerated() === true` on
   * the way out and migrates the driver storage + emits a new Set-Cookie.
   */
  regenerate(): void {
    this.#sessionId = generateSessionId()
    this.#regenerated = true
    this.#dirty = true
  }

  /** @internal — read by SessionMiddleware to detect a mid-request rotation. */
  wasRegenerated(): boolean {
    return this.#regenerated
  }

  /** @internal — the id captured at request arrival; used to destroy the old driver entry post-regenerate. */
  originalSessionId(): string {
    return this.#originalSessionId
  }

  /** Get a session value. */
  get<T = unknown>(key: string, defaultValue?: T): T {
    if (key in this.#data) {
      // biome-ignore lint/suspicious/noExplicitAny: session data stored as unknown; caller brands the value type via T
      return this.#data[key] as any as T
    }
    // biome-ignore lint/suspicious/noExplicitAny: generic default — caller brands the value type via T
    return defaultValue as any as T
  }

  /** Set a session value. */
  put(key: string, value: unknown): void {
    this.#data[key] = value
    this.#dirty = true
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return key in this.#data
  }

  /** Get all session data. */
  all(): Record<string, unknown> {
    return { ...this.#data }
  }

  /** Remove a key. */
  forget(key: string): void {
    delete this.#data[key]
    this.#dirty = true
  }

  /** Get and remove a key. */
  pull<T = unknown>(key: string, defaultValue?: T): T {
    const value = this.get<T>(key, defaultValue)
    this.forget(key)
    return value
  }

  /** Clear all session data. */
  clear(): void {
    this.#data = {}
    this.#dirty = true
  }

  /** Increment a numeric value. */
  increment(key: string, amount = 1): void {
    const current = this.get<number>(key) ?? 0
    this.put(key, current + amount)
  }

  /** Decrement a numeric value. */
  decrement(key: string, amount = 1): void {
    this.increment(key, -amount)
  }

  // ─── Flash data ───────────────────────────────────────────

  /** Set flash data (available only on the next request). */
  flash(key: string, value: unknown): void {
    this.#flashData[key] = value
    this.#dirty = true
  }

  /** Flash all current input. */
  flashAll(input: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(input)) {
      this.#flashData[k] = v
    }
    this.#dirty = true
  }

  /** Flash only specific keys. */
  flashOnly(input: Record<string, unknown>, keys: string[]): void {
    for (const k of keys) {
      if (k in input) this.#flashData[k] = input[k]
    }
    this.#dirty = true
  }

  /** Flash all except specific keys. */
  flashExcept(input: Record<string, unknown>, keys: string[]): void {
    const keySet = new Set(keys)
    for (const [k, v] of Object.entries(input)) {
      if (!keySet.has(k)) this.#flashData[k] = v
    }
    this.#dirty = true
  }

  /** Get a flashed value from the previous request. */
  flashMessages(): Record<string, unknown> {
    return { ...this.#previousFlash }
  }

  /** Get a specific flash message from the previous request. */
  old<T = unknown>(key: string, defaultValue?: T): T {
    if (key in this.#previousFlash) {
      // biome-ignore lint/suspicious/noExplicitAny: flash data stored as unknown; caller brands the value type via T
      return this.#previousFlash[key] as any as T
    }
    // biome-ignore lint/suspicious/noExplicitAny: generic default — caller brands the value type via T
    return defaultValue as any as T
  }

  // ─── Serialization ────────────────────────────────────────

  /** Serialize for storage. Includes flash data for next request. */
  toJSON(): Record<string, unknown> {
    const result = { ...this.#data }
    if (Object.keys(this.#flashData).length > 0) {
      result.__flash = this.#flashData
    }
    return result
  }

  isDirty(): boolean {
    return this.#dirty
  }
}

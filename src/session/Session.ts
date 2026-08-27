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
  /**
   * The stored session, or `null` when the store has no entry for this id
   * (AdonisJS `SessionStoreContract.read`).
   *
   * `null` and `{}` mean different things: the first is "no session here",
   * the second "a session that happens to be empty". Without the difference a
   * cookie whose server-side row has expired looked like a live session, and
   * `commit()` touched a row that was not there.
   */
  read(sessionId: string): Promise<Record<string, unknown> | null>
  write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void>
  destroy(sessionId: string): Promise<void>
  touch(sessionId: string, ttl: number): Promise<void>
}

/** One session belonging to a tagged user (AdonisJS `TaggedSession`). */
export interface TaggedSession {
  id: string
  data: Record<string, unknown>
}

/**
 * A driver that can associate a session with a user, so every session a user
 * holds can be listed or destroyed — "log me out everywhere", and "these are
 * your active devices" (AdonisJS `SessionStoreWithTaggingContract`).
 *
 * Only the drivers that keep a queryable index can answer: memory, redis and
 * database. The cookie driver holds no server-side state at all, and the file
 * driver would have to scan the directory on every lookup.
 */
export interface SessionDriverWithTagging extends SessionDriver {
  tag(sessionId: string, userId: string | number): Promise<void>
  untag(sessionId: string, userId: string | number): Promise<void>
  /** Every non-expired session tagged with this user. */
  tagged(userId: string | number): Promise<TaggedSession[]>
}

/** Whether a driver carries the tagging half of the contract. */
export function supportsTagging(driver: SessionDriver): driver is SessionDriverWithTagging {
  return (
    'tag' in driver &&
    typeof (driver as SessionDriverWithTagging).tag === 'function' &&
    'tagged' in driver &&
    typeof (driver as SessionDriverWithTagging).tagged === 'function'
  )
}

/**
 * The session key the flash bag travels in.
 *
 * One constant rather than three literals: the read, the delete and the write
 * below all have to agree, and they had to agree by hand.
 */
const FLASH_KEY = '__flash'

/** Where `flashAll` / `flashOnly` / `flashExcept` put the request input. */
const FLASH_INPUT_KEY = 'input'

/** Where the intended URL is stored, out of the way of app keys. */
const INTENDED_URL_KEY = '__intended_url'

export interface SessionConfig {
  /**
   * Which store to use. AdonisJS names this key `store`; `driver` is ream's
   * older spelling and both are accepted, so a migrated `config/session.ts`
   * runs with its imports rewritten and nothing else.
   */
  driver?: string
  /** AdonisJS spelling of {@link driver}. */
  store?: string
  /**
   * Named stores, AdonisJS-style: `{ store: 'redis', stores: { redis: … } }`.
   * The selected entry supplies the driver name and its options.
   */
  stores?: Record<string, { driver: string } & Record<string, unknown>>
  /** `file` driver only — the directory session files are written to. */
  location?: string
  /** `database` driver only — the connection to store sessions on. */
  dbConnection?: unknown
  /** `database` driver only — the table holding them (default `sessions`). */
  tableName?: string
  /**
   * `database` driver only — percent chance that a write also sweeps expired
   * rows (AdonisJS `gcProbability`, default 2). `0` turns it off.
   */
  gcProbability?: number
  cookieName?: string
  /**
   * Session lifetime. A bare number is SECONDS; a string carries a unit
   * (`'2h'`), which is how AdonisJS writes it (`age: string | number`).
   */
  age?: number | string
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

/** A non-null, non-array object — the shape flash data must have to be keyed. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class Session {
  #data: Record<string, unknown> = {}
  #flashData: Record<string, unknown> = {}
  #previousFlash: Record<string, unknown> = {}
  #dirty = false
  /** Reads the request's original input; absent outside a request. */
  #readInput?: () => Record<string, unknown>
  #sessionId: string
  /**
   * The session id active when the request arrived, captured at construction.
   * The middleware uses this on the way out to migrate driver storage
   * (`driver.write(newId)` + `driver.destroy(oldId)`) when the application
   * called `regenerate()` mid-request.
   */
  readonly #originalSessionId: string
  #regenerated = false
  /** Whether this session was created for THIS request (no incoming cookie). */
  #fresh = false
  /** The store behind it, when there is one — absent for a bare unit-test session. */
  #driver?: SessionDriver
  /** Session lifetime in seconds, used by {@link commit}. */
  #ttl = 0
  /** Whether {@link initiate} already ran, so a second call is a no-op. */
  #initiated = false

  constructor(sessionId: string, data: Record<string, unknown> = {}) {
    this.#sessionId = sessionId
    this.#originalSessionId = sessionId
    this.#hydrate(data)
  }

  /**
   * Seat stored data: the payload becomes the session, and the flash bag it
   * carried becomes THIS request's `old()` / `flashMessages`.
   *
   * Shared by the constructor and {@link initiate}, so a session loaded from
   * the store lands in exactly the same state as one handed its data directly.
   */
  #hydrate(data: Record<string, unknown>): void {
    this.#data = { ...data }
    const flash = data[FLASH_KEY]
    this.#previousFlash = isPlainRecord(flash) ? { ...flash } : {}
    delete this.#data[FLASH_KEY]
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
    // The store is untyped by nature, so `T` is the CALLER's claim about what
    // it put there — one assertion from `unknown`, which is what `T` means
    // here. Going through `any` first widened nothing and hid the intent.
    if (key in this.#data) return this.#data[key] as T
    return defaultValue as T
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

  /**
   * @internal Give the session read access to the request's ORIGINAL input.
   *
   * AdonisJS's session holds the HTTP context and reads `request.original()`;
   * ream's Session stays free of it, so the middleware injects a reader. Absent
   * (a session built outside a request), the input-flashing methods flash
   * nothing rather than throwing.
   */
  setInputReader(read: () => Record<string, unknown>): void {
    this.#readInput = read
  }

  /** The request's original input, or nothing when there is no request. */
  #input(): Record<string, unknown> {
    return this.#readInput?.() ?? {}
  }

  /**
   * Set flash data, available only on the next request.
   *
   * Takes a key and a value, or an object of both (AdonisJS accepts either).
   */
  flash(key: string | Record<string, unknown>, value?: unknown): void {
    if (typeof key === 'string') this.#flashData[key] = value
    else Object.assign(this.#flashData, key)
    this.#dirty = true
  }

  /**
   * Flash the whole request input for the next request (AdonisJS `flashAll`).
   *
   * Takes NO argument: it reads the request's original input itself, which is
   * what makes `session.flashAll()` before a redirect-back repopulate a form.
   */
  flashAll(): void {
    this.flash(FLASH_INPUT_KEY, this.#input())
  }

  /** Flash only these input keys (AdonisJS `flashOnly`). */
  flashOnly(keys: string[]): void {
    const input = this.#input()
    const picked: Record<string, unknown> = {}
    for (const key of keys) {
      if (Object.hasOwn(input, key)) picked[key] = input[key]
    }
    this.flash(FLASH_INPUT_KEY, picked)
  }

  /**
   * Flash the request input except these keys (AdonisJS `flashExcept`).
   *
   *   session.flashExcept(['password', '_csrf'])
   */
  flashExcept(keys: string[]): void {
    const omit = new Set(keys)
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this.#input())) {
      if (!omit.has(key)) kept[key] = value
    }
    this.flash(FLASH_INPUT_KEY, kept)
  }

  /**
   * Flash an error collection under `errorsBag` (AdonisJS `flashErrors`) —
   * where the `@error` / `@errors` template tags read from.
   */
  flashErrors(errors: Record<string, string | string[]>): void {
    this.flash({ errorsBag: errors })
  }

  /**
   * Flash a validation failure the way a form expects it (AdonisJS
   * `flashValidationErrors`): the per-field messages under `inputErrorsBag`,
   * a summary under `errorsBag`, and — unless told otherwise — the input, so
   * the redisplayed form keeps what the user typed.
   */
  flashValidationErrors(
    error: { code?: string; messages?: Array<{ field?: string; message?: string }> },
    withInput = true,
  ): void {
    const bag: Record<string, string[]> = {}
    for (const message of error.messages ?? []) {
      if (message.field === undefined || message.message === undefined) continue
      const existing = bag[message.field] ?? []
      existing.push(message.message)
      bag[message.field] = existing
    }
    this.flash('inputErrorsBag', bag)
    this.flashErrors({
      [error.code ?? 'E_VALIDATION_ERROR']: Object.values(bag).flat(),
    })
    if (withInput) this.flashAll()
  }

  /**
   * Keep the PREVIOUS request's flash data for one more request (AdonisJS
   * `reflash`) — what a redirect chain needs so a message survives the hop.
   */
  reflash(): void {
    this.flash(this.#previousFlash)
  }

  /** Keep only these keys of the previous flash data (AdonisJS `reflashOnly`). */
  reflashOnly(keys: string[]): void {
    for (const key of keys) {
      if (Object.hasOwn(this.#previousFlash, key)) {
        this.flash(key, this.#previousFlash[key])
      }
    }
  }

  /** Keep the previous flash data except these keys (AdonisJS `reflashExcept`). */
  reflashExcept(keys: string[]): void {
    const omit = new Set(keys)
    for (const [key, value] of Object.entries(this.#previousFlash)) {
      if (!omit.has(key)) this.flash(key, value)
    }
  }

  // ─── Intended URL ─────────────────────────────────────────

  /**
   * Remember where the user was heading (AdonisJS `setIntendedUrl`).
   *
   * An auth middleware stores it before redirecting to the login page, so the
   * user lands back on the page they asked for instead of a generic dashboard.
   */
  setIntendedUrl(url: string): void {
    this.put(INTENDED_URL_KEY, url)
  }

  /** The remembered URL, or null. */
  getIntendedUrl(): string | null {
    const url = this.get<string>(INTENDED_URL_KEY)
    return typeof url === 'string' ? url : null
  }

  /** Read it and forget it — the usual call right after a successful login. */
  pullIntendedUrl(): string | null {
    const url = this.getIntendedUrl()
    this.clearIntendedUrl()
    return url
  }

  clearIntendedUrl(): void {
    this.forget(INTENDED_URL_KEY)
  }

  /** Get a flashed value from the previous request. */
  flashMessages(): Record<string, unknown> {
    return { ...this.#previousFlash }
  }

  /** Get a specific flash message from the previous request. */
  old<T = unknown>(key: string, defaultValue?: T): T {
    // Same contract as `get`: `T` is the caller's claim about a store that is
    // untyped by nature.
    if (key in this.#previousFlash) return this.#previousFlash[key] as T
    return defaultValue as T
  }

  // ─── Serialization ────────────────────────────────────────

  /** Serialize for storage. Includes flash data for next request. */
  toJSON(): Record<string, unknown> {
    const result = { ...this.#data }
    if (Object.keys(this.#flashData).length > 0) {
      result[FLASH_KEY] = this.#flashData
    }
    return result
  }

  isDirty(): boolean {
    return this.#dirty
  }

  /** AdonisJS spelling of {@link isDirty}. */
  get hasBeenModified(): boolean {
    return this.#dirty
  }

  /**
   * Whether this session was created during THIS request — no session cookie
   * came in with it (AdonisJS `fresh`).
   */
  get fresh(): boolean {
    return this.#fresh
  }

  /**
   * Whether the session holds nothing (AdonisJS `isEmpty`). Flash data counts:
   * a session carrying only a flash message still has something to write.
   */
  get isEmpty(): boolean {
    return Object.keys(this.#data).length === 0 && Object.keys(this.#flashData).length === 0
  }

  /**
   * Whether writes are refused (AdonisJS `readonly`). Always false here: ream
   * has no read-only session mode, and reporting `true` would tell a caller
   * its writes were dropped when they were not.
   */
  /**
   * The options this session was seated with (AdonisJS `config`).
   *
   * What `setStore` was told: whether the session is fresh, and how long it
   * lives. Read-only — changing it after the fact would not move the entry
   * already written.
   */
  get config(): { fresh: boolean; ttl: number } {
    return { fresh: this.#fresh, ttl: this.#ttl }
  }

  /**
   * The key the flash bag is stored under inside the session (AdonisJS
   * `flashKey`).
   *
   * Exposed so a store that has to reason about the payload — a migration, a
   * debug screen — does not have to hardcode the string.
   */
  get flashKey(): string {
    return FLASH_KEY
  }

  /**
   * What has been flashed for the NEXT request (AdonisJS
   * `responseFlashMessages`).
   *
   * A copy: flashing goes through `flash()`, which is where the value checks
   * live. `flashMessages` is the other half — what the PREVIOUS request left
   * for this one.
   */
  get responseFlashMessages(): Record<string, unknown> {
    return { ...this.#flashData }
  }

  /**
   * Whether `regenerate()` ran this request (AdonisJS `hasRegeneratedSession`).
   *
   * The id changed, so anything holding the old one — a cookie already
   * written, an external store keyed by session id — is stale. It was tracked
   * internally and never exposed, so only this class could act on it.
   */
  get hasRegeneratedSession(): boolean {
    return this.#regenerated
  }

  get readonly(): boolean {
    return false
  }

  /**
   * @internal Wire the store this session lives in. Called by
   * `SessionMiddleware`; a session built by hand in a test has none, and
   * {@link initiate} / {@link commit} then have nothing to do.
   */
  setStore(driver: SessionDriver, options: { fresh: boolean; ttl: number }): void {
    this.#driver = driver
    this.#fresh = options.fresh
    this.#ttl = options.ttl
  }

  /**
   * Load the session from its store (AdonisJS `initiate`).
   *
   * Idempotent, as upstream: calling it twice is a no-op, so a middleware that
   * runs on a sub-request cannot wipe what the outer one already read.
   */
  async initiate(): Promise<void> {
    if (this.#initiated || this.#driver === undefined) return
    this.#initiated = true
    const stored = await this.#driver.read(this.#sessionId)
    // The store is the authority on existence: a cookie can outlive the row it
    // points at, and that session is fresh however old its id is.
    if (stored === null) this.#fresh = true
    this.#hydrate(stored ?? {})
  }

  /**
   * Persist the session to its store (AdonisJS `commit`).
   *
   * - regenerated: write under the NEW id first, then drop the old entry, so a
   *   crash between the two leaves the user with a valid session under one id
   *   rather than none.
   * - modified: write.
   * - untouched but pre-existing: touch, to slide the expiry.
   * - untouched and brand new: nothing. Writing here would hand out a session
   *   id pointing at a row nobody asked for.
   */
  async commit(): Promise<void> {
    const driver = this.#driver
    if (driver === undefined) return
    if (this.#regenerated) {
      await driver.write(this.#sessionId, this.toJSON(), this.#ttl)
      try {
        await driver.destroy(this.#originalSessionId)
      } catch {
        // Benign: a stale entry the TTL reclaims. The session is already live
        // under the new id, and failing the request here would be worse.
      }
      return
    }
    if (this.#dirty) {
      await driver.write(this.#sessionId, this.toJSON(), this.#ttl)
      return
    }
    if (!this.#fresh) await driver.touch(this.#sessionId, this.#ttl)
  }

  /**
   * Whether the store behind this session can tag sessions with a user
   * (AdonisJS `supportsTagging`). False under the cookie and file drivers.
   */
  supportsTagging(): boolean {
    return this.#driver !== undefined && supportsTagging(this.#driver)
  }

  /**
   * Associate this session with a user, so every session that user holds can
   * be found later (AdonisJS `tag`) — what "log out from all my devices" and
   * "your active sessions" are built on. Call it at login.
   */
  async tag(userId: string | number): Promise<void> {
    await this.#taggingDriver('tag').tag(this.#sessionId, userId)
  }

  /** Drop the association made by {@link tag} (AdonisJS `untag`). Call it at logout. */
  async untag(userId: string | number): Promise<void> {
    await this.#taggingDriver('untag').untag(this.#sessionId, userId)
  }

  /**
   * The store, asserted to support tagging. Throws naming the method rather
   * than resolving to a no-op: a login that believes it tagged the session
   * would leave "log out everywhere" silently doing nothing.
   */
  #taggingDriver(method: string): SessionDriverWithTagging {
    if (this.#driver === undefined) {
      throw new Error(
        `session.${method}() needs a session store — this session was built without one.`,
      )
    }
    if (!supportsTagging(this.#driver)) {
      throw new Error(
        `session.${method}() is not supported by the configured session store. Use the memory, redis, or database store.`,
      )
    }
    return this.#driver
  }
}

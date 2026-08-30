/**
 * Session middleware — initializes session on each request.
 *
 * Reads session ID from cookie, loads data via driver, attaches to ctx,
 * and writes back after the handler runs.
 */

import { randomBytes } from 'node:crypto'
import { currentNodeEnv } from '../env/nodeEnv.js'
import { durationToSeconds } from '../helpers/duration.js'
import type { HttpContext } from '../http/HttpContext.js'
import { CookieDriver } from './drivers/CookieDriver.js'
import { DatabaseDriver, type SessionDbConnection } from './drivers/DatabaseDriver.js'
import { FileDriver } from './drivers/FileDriver.js'
import { MemoryDriver } from './drivers/MemoryDriver.js'
import { RedisDriver } from './drivers/RedisDriver.js'
import { quasarConnection } from './quasar.js'
import { ReadOnlyValuesStore, type ValuePath } from './ReadOnlyValuesStore.js'
import type { SessionConfig, SessionDriver } from './Session.js'
import { Session } from './Session.js'

interface ResolvedSessionConfig {
  driver: string
  cookieName: string
  maxAge: number
  clearWithBrowser: boolean
  rolling: boolean
}

/** Duck-typed check for a connection the database store can drive. */
function isSessionDbConnection(value: unknown): value is SessionDbConnection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'query') === 'function' &&
    typeof Reflect.get(value, 'execute') === 'function'
  )
}

export default class SessionMiddleware {
  #driver: SessionDriver
  #cookieDriver: CookieDriver | null = null
  #config: ResolvedSessionConfig

  constructor(config?: SessionConfig & { secret?: string }) {
    // `store` + `stores` (AdonisJS) and `driver` (ream) name the same thing.
    // A named store supplies the driver and its own options, so
    // `{ store: 'redis', stores: { redis: { driver: 'redis' } } }` works.
    const selected = config?.store ?? config?.driver
    const named = selected ? config?.stores?.[selected] : undefined
    this.#config = {
      driver: named?.driver ?? selected ?? 'memory',
      cookieName: config?.cookieName ?? 'ream_session',
      // `age` is the AdonisJS key and accepts a duration string.
      maxAge:
        config?.age !== undefined
          ? durationToSeconds(config.age, 'a session age')
          : (config?.maxAge ?? 7200),
      clearWithBrowser: config?.clearWithBrowser ?? false,
      rolling: config?.rolling ?? false,
    }

    if (this.#config.driver === 'cookie') {
      if (!config?.secret) {
        throw new Error(
          'Cookie session driver requires a secret. Set session.secret in your config.',
        )
      }
      this.#cookieDriver = new CookieDriver(config.secret)
      this.#driver = this.#cookieDriver
    } else if (this.#config.driver === 'memory') {
      this.#driver = new MemoryDriver()
    } else if (this.#config.driver === 'file') {
      const location = config?.location ?? named?.location
      if (typeof location !== 'string') {
        throw new Error(
          'File session driver requires a `location`. Set session.location (or stores.<name>.location) to a writable directory.',
        )
      }
      this.#driver = new FileDriver({ location })
    } else if (this.#config.driver === 'database') {
      const connection = config?.dbConnection ?? named?.connection
      if (!isSessionDbConnection(connection)) {
        throw new Error(
          'Database session driver requires a `connection` exposing query() and execute().',
        )
      }
      this.#driver = new DatabaseDriver({
        connection,
        tableName: typeof config?.tableName === 'string' ? config.tableName : undefined,
        gcProbability: typeof config?.gcProbability === 'number' ? config.gcProbability : undefined,
      })
    } else if (this.#config.driver === 'redis') {
      // Either the app hands a client in, or it names a quasar connection —
      // the same choice echo, bay and warden offer. Nothing is dialled here:
      // the driver resolves on the first request that reads a session.
      const source = config?.client ?? quasarConnection(config?.connection)
      this.#driver = new RedisDriver(source, { prefix: config?.prefix })
    } else {
      throw new Error(`Unknown session driver: ${this.#config.driver}`)
    }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const cookieName = this.#config.cookieName
    const maxAge = this.#config.maxAge
    const rolling = this.#config.rolling
    // Normalised: `NODE_ENV=prod` reaching here as "not production" ships
    // the session cookie without Secure, over plain HTTP.
    const isProduction = currentNodeEnv() === 'production'

    // Read the session cookie — pre-parsed by the Rust HyperServer.
    //
    // The COOKIE driver's value is its own AEAD ciphertext, so it is read raw
    // and the driver authenticates it. The server-side drivers store a bare id,
    // which is SIGNED on the way out (see the write below): `request.cookie()`
    // verifies the HMAC and returns null when it does not hold, so a planted or
    // foreign id is refused here instead of reaching the store.
    let sessionId = this.#cookieDriver
      ? ctx.request.plainCookie<string>(cookieName, undefined, { encoded: false })
      : ctx.request.cookie(cookieName)
    const hadIncomingCookie = sessionId !== null

    // Cookie driver: the cookie value IS the session data (encrypted)
    if (this.#cookieDriver) {
      const data = await this.#driver.read(sessionId ?? '')
      sessionId = sessionId ?? generateSessionId()
      // `null` means the cookie carried nothing readable — an empty session,
      // not an absent one, since for this driver the cookie IS the store.
      const session = new Session(sessionId, data ?? {})
      // No store to commit to: the cookie written below IS the storage, so the
      // session is seated without one and `commit()` has nothing to do.
      session.setStore(this.#driver, { fresh: !hadIncomingCookie, ttl: maxAge })
      ctx.store.set('session', session)
      ctx.session = session
      session.setInputReader(() => ctx.request.original())
      // Same as the server-side branch below: without it `{{ flashMessages }}`
      // and the `@error` / `@errors` / `@inputError` tags saw nothing at all
      // under the cookie driver, so a form silently lost its messages.
      shareSessionWithView(ctx, session)

      await next()

      // Default: only emit Set-Cookie if the session was actually modified —
      // sending a cookie on every response defeats HTTP caching, leaks state
      // to CDNs, and creates a privacy side-channel (response varies even for
      // read-only GETs).
      // Rolling mode: re-emit on every response with an existing session so
      // the cookie maxAge window slides forward (active users don't time out
      // mid-session). Caller opts in via SessionConfig.rolling.
      const shouldEmit = session.isDirty() || (rolling && hadIncomingCookie)
      if (shouldEmit) {
        const encoded = this.#cookieDriver.encode(session.toJSON())
        if (encoded.length > 4096) {
          process.stderr.write(
            `[session] Cookie session exceeds 4096 bytes (${encoded.length}). ` +
              'Switch to a server-side driver (memory/redis) or reduce session data.\n',
          )
        }
        ctx.response.plainCookie(cookieName, encoded, {
          // Already encrypted by the cookie driver; packing it again would
          // only make the cookie bigger and change nothing.
          encode: false,
          maxAge: this.#config.clearWithBrowser ? undefined : maxAge,
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: isProduction,
        })
      }
      return
    }

    // Server-side drivers (memory, redis)
    if (!sessionId) {
      sessionId = generateSessionId()
    }

    const session = new Session(sessionId)
    session.setStore(this.#driver, { fresh: !hadIncomingCookie, ttl: maxAge })
    await session.initiate()
    ctx.store.set('session', session)
    ctx.session = session
    // `flashAll()` takes no argument (AdonisJS): it reads the request's own
    // input, which is what repopulates a form after a redirect-back.
    session.setInputReader(() => ctx.request.original())
    shareSessionWithView(ctx, session)

    await next()

    // The store half of the lifecycle — including the session-fixation
    // migration when the handler called `regenerate()` — belongs to the
    // session, as it does upstream.
    const regenerated = session.wasRegenerated()
    await session.commit()

    // Emit Set-Cookie only when there is server-side state worth
    // pinning to the browser: the session was modified (isDirty → we
    // just wrote it), regenerated (rotated id post-login), or rolling
    // mode is sliding an existing session's window. A brand-new but
    // CLEAN anonymous request gets NO cookie — otherwise every first
    // read-only GET hands out a persistent tracking id that points at
    // no server-side row (touch() is a no-op without a backing entry),
    // defeats HTTP caching, and leaks a Set-Cookie to CDNs. This mirrors
    // the cookie-driver path above (which already omits `isNew`).
    if (session.isDirty() || regenerated || (rolling && hadIncomingCookie)) {
      // SIGNED, as AdonisJS signs it (`response.cookie(cookieName, id, …)`).
      // The id is 192 bits of entropy, so it was never guessable — what the
      // signature buys is that a cookie the app did not issue is rejected on
      // read, before any store lookup, and that an id from another deployment
      // (a different APP_KEY) cannot be presented here.
      ctx.response.cookie(cookieName, session.sessionId, {
        maxAge: this.#config.clearWithBrowser ? undefined : maxAge,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
      })
    }
  }
}

function generateSessionId(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Share the session with the request's view, as AdonisJS's session does.
 *
 * A migrated template reads `{{ old('email') }}`, `@error('email')` and
 * `{{ flashMessages.get(...) }}` unchanged, so the three names and their shapes
 * have to match. Skipped when the app installed no template layer.
 */
function shareSessionWithView(ctx: HttpContext, session: Session): void {
  const view = Reflect.get(Object(ctx), 'view')
  const share = Reflect.get(Object(view), 'share')
  if (typeof share !== 'function') return
  // The session hands back a store already — no need to rebuild one here.
  const flashMessages = session.flashMessages
  share.call(view, {
    session: new ReadOnlyValuesStore(session.all()),
    flashMessages,
    // Adonis exposes the previous request's input under `old`.
    old: (key: ValuePath, defaultValue?: unknown): unknown => flashMessages.get(key, defaultValue),
  })
}

/**
 * Session middleware — initializes session on each request.
 *
 * Reads session ID from cookie, loads data via driver, attaches to ctx,
 * and writes back after the handler runs.
 */

import { randomBytes } from 'node:crypto'
import type { HttpContext } from '../http/HttpContext.js'
import { CookieDriver } from './drivers/CookieDriver.js'
import { MemoryDriver } from './drivers/MemoryDriver.js'
import type { SessionConfig, SessionDriver } from './Session.js'
import { Session } from './Session.js'

interface ResolvedSessionConfig {
  driver: string
  cookieName: string
  maxAge: number
  clearWithBrowser: boolean
  rolling: boolean
}

export default class SessionMiddleware {
  #driver: SessionDriver
  #cookieDriver: CookieDriver | null = null
  #config: ResolvedSessionConfig

  constructor(config?: SessionConfig & { secret?: string }) {
    this.#config = {
      driver: config?.driver ?? 'memory',
      cookieName: config?.cookieName ?? 'ream_session',
      maxAge: config?.maxAge ?? 7200,
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
    } else {
      throw new Error(`Unknown session driver: ${this.#config.driver}`)
    }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const cookieName = this.#config.cookieName
    const maxAge = this.#config.maxAge
    const rolling = this.#config.rolling
    const isProduction = process.env.NODE_ENV === 'production'

    // Read session ID from cookie — pre-parsed by the Rust HyperServer.
    let sessionId = ctx.request.plainCookie(cookieName)
    const hadIncomingCookie = sessionId !== null

    // Cookie driver: the cookie value IS the session data (encrypted)
    if (this.#cookieDriver) {
      const data = await this.#driver.read(sessionId ?? '')
      sessionId = sessionId ?? generateSessionId()
      const session = new Session(sessionId, data)
      ctx.store.set('session', session)
      ctx.session = session

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

    const data = await this.#driver.read(sessionId)
    const session = new Session(sessionId, data)
    ctx.store.set('session', session)
    ctx.session = session

    await next()

    // Session-fixation mitigation: if the handler called `session.regenerate()`
    // (typically via Warden's SessionStrategy.login), the session id has been
    // rotated. Migrate the driver storage atomically — write under the new
    // id first, then destroy the old entry so a crash between calls leaves
    // the user with a valid session under one of the two ids rather than
    // none. The cookie below picks up `session.sessionId` which already
    // returns the new value.
    const regenerated = session.wasRegenerated()
    const isNew = !hadIncomingCookie
    if (regenerated) {
      const originalId = session.originalSessionId()
      const currentId = session.sessionId
      await this.#driver.write(currentId, session.toJSON(), maxAge)
      // Best-effort: a destroy failure leaves a stale entry that TTL will
      // sweep, but should not crash the request. The new session is already
      // live under `currentId`.
      try {
        await this.#driver.destroy(originalId)
      } catch {
        // benign — TTL will reclaim it.
      }
    } else if (session.isDirty()) {
      await this.#driver.write(sessionId, session.toJSON(), maxAge)
    } else if (!isNew) {
      await this.#driver.touch(sessionId, maxAge)
    }

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
      ctx.response.plainCookie(cookieName, session.sessionId, {
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

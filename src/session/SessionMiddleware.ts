/**
 * Session middleware — initializes session on each request.
 *
 * Reads session ID from cookie, loads data via driver, attaches to ctx,
 * and writes back after the handler runs.
 */

import { randomBytes } from 'node:crypto'
import type { HttpContext } from '../http/HttpContext.js'
import { Session } from './Session.js'
import type { SessionConfig, SessionDriver } from './Session.js'
import { MemoryDriver } from './drivers/MemoryDriver.js'
import { CookieDriver } from './drivers/CookieDriver.js'

const drivers: Record<string, () => SessionDriver> = {
  memory: () => new MemoryDriver(),
  cookie: () => new CookieDriver(),
}

export default class SessionMiddleware {
  private driver: SessionDriver
  private config: SessionConfig

  constructor(config?: SessionConfig) {
    this.config = {
      driver: config?.driver ?? 'memory',
      cookieName: config?.cookieName ?? 'ream_session',
      maxAge: config?.maxAge ?? 7200,
      clearWithBrowser: config?.clearWithBrowser ?? false,
    }
    const factory = drivers[this.config.driver]
    if (!factory) throw new Error(`Unknown session driver: ${this.config.driver}`)
    this.driver = factory()
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const cookieName = this.config.cookieName!
    const maxAge = this.config.maxAge!

    // Read session ID from cookie
    let sessionId = parseCookie(ctx.request.header('cookie') ?? '', cookieName)

    // Cookie driver: the cookie value IS the session data
    if (this.config.driver === 'cookie') {
      const data = await this.driver.read(sessionId ?? '')
      sessionId = sessionId ?? generateSessionId()
      const session = new Session(sessionId, data)
      ctx.store.set('session', session)

      await next()

      // Write session data back to cookie
      const encoded = CookieDriver.encode(session.toJSON())
      ctx.response.cookie(cookieName, encoded, {
        maxAge: this.config.clearWithBrowser ? undefined : maxAge,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
      })
      return
    }

    // Server-side drivers (memory, redis)
    if (!sessionId) {
      sessionId = generateSessionId()
    }

    const data = await this.driver.read(sessionId)
    const session = new Session(sessionId, data)
    ctx.store.set('session', session)

    await next()

    // Persist session
    if (session.isDirty()) {
      await this.driver.write(sessionId, session.toJSON(), maxAge)
    } else {
      await this.driver.touch(sessionId, maxAge)
    }

    // Set session cookie
    ctx.response.cookie(cookieName, sessionId, {
      maxAge: this.config.clearWithBrowser ? undefined : maxAge,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    })
  }
}

function generateSessionId(): string {
  return randomBytes(24).toString('base64url')
}

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const pair of cookieHeader.split(';')) {
    const [k, v] = pair.trim().split('=')
    if (k === name && v) return decodeURIComponent(v)
  }
  return null
}

/**
 * Two session hardening rules.
 *
 * 1. No implicit store in production. With no `store` configured the session
 *    fell back to the in-process memory store silently: a restart, a second
 *    replica, or ten thousand anonymous requests signed every user out.
 *    The memory store itself now evicts least-recently-USED first, so a user
 *    who keeps browsing is not first in line.
 *
 * 2. The session cookie's attributes come from `cookie` in the session
 *    config. They were hard-coded (`sameSite: 'lax'`, no domain, `secure`
 *    tied to NODE_ENV), so an app could not harden or scope its cookie.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import { defineConfig, type SessionConfigInput } from '../../src/session/config.js'
import { MemoryDriver } from '../../src/session/drivers/MemoryDriver.js'
import {
  E_SESSION_COOKIE_NOT_HTTP_ONLY,
  E_SESSION_STORE_NOT_CONFIGURED,
} from '../../src/session/errors.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

const signer = new CookieSigner('a-sufficiently-long-app-key-for-tests')

function makeCtx(): HttpContext {
  const ctx = new HttpContext(
    'req-1',
    { method: 'GET', path: '/', query: '', headers: {}, body: '' },
    {},
    { pattern: '/', middleware: [] },
  )
  ctx.setCookieSigner(signer)
  return ctx
}

/** Run one request that writes to the session; answer its Set-Cookie line. */
async function sessionCookie(config: SessionConfigInput): Promise<string> {
  const ctx = makeCtx()
  await new SessionMiddleware(config).handle(ctx, async () => {
    ctx.session?.put('user', 1)
  })
  const header = ctx.response.getHeaders()['set-cookie'] ?? ''
  const line = header.split('\n').find((cookie) => cookie.startsWith('ream_session='))
  if (line === undefined) throw new Error(`no session cookie in ${JSON.stringify(header)}`)
  return line
}

function attributes(line: string): string[] {
  return line
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase())
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ream > a session store must be chosen', () => {
  for (const env of ['production', 'prod', 'development', 'test']) {
    it(`refuses to start without a store (NODE_ENV=${env})`, () => {
      vi.stubEnv('NODE_ENV', env)
      expect(() => new SessionMiddleware({})).toThrow(E_SESSION_STORE_NOT_CONFIGURED)
      expect(() => new SessionMiddleware({ cookieName: 'sid' })).toThrow(/config\/session\.ts/)
    })
  }

  it('refuses when no argument is passed and no config file declares one', () => {
    expect(() => new SessionMiddleware()).toThrow(E_SESSION_STORE_NOT_CONFIGURED)
  })

  it('refuses a stores map when no store is selected from it', () => {
    expect(() => new SessionMiddleware({ stores: { memory: { driver: 'memory' } } })).toThrow(
      E_SESSION_STORE_NOT_CONFIGURED,
    )
  })

  it('accepts the memory store when it is chosen explicitly, in production too', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => new SessionMiddleware({ store: 'memory' })).not.toThrow()
    expect(() => new SessionMiddleware({ driver: 'memory' })).not.toThrow()
  })

  it('accepts any configured store', () => {
    expect(() => new SessionMiddleware({ store: 'cookie', secret: '0'.repeat(32) })).not.toThrow()
  })

  it('is refused by defineConfig already, when the config file is loaded', () => {
    expect(() => defineConfig({ cookieName: 'sid' })).toThrow(E_SESSION_STORE_NOT_CONFIGURED)
    expect(defineConfig({ store: 'memory' })).toEqual({ store: 'memory' })
    expect(defineConfig({ driver: 'redis' })).toEqual({ driver: 'redis' })
  })
})

describe('ream > memory store evicts the least recently used session', () => {
  it('keeps a session in use through a flood of 20 000 anonymous writes', async () => {
    const driver = new MemoryDriver()
    await driver.write('victim', { auth_web: 'u1' }, 7200)
    await driver.write('idle', { auth_web: 'u2' }, 7200)
    for (let i = 0; i < 20_000; i++) {
      await driver.write(`anon-${i}`, { _csrf: 'x' }, 7200)
      // The victim keeps browsing: a clean request only touches the session.
      if (i % 1000 === 0) await driver.touch('victim', 7200)
    }
    expect(await driver.read('victim')).toEqual({ auth_web: 'u1' })
    // The one that went quiet was the one dropped.
    expect(await driver.read('idle')).toBe(null)
  })

  it('evicts in least-recently-used order with a small cap', async () => {
    const driver = new MemoryDriver({ maxEntries: 3 })
    await driver.write('a', {}, 60)
    await driver.write('b', {}, 60)
    await driver.write('c', {}, 60)
    await driver.touch('a', 60)
    await driver.write('d', {}, 60)
    expect(await driver.read('b')).toBe(null)
    expect(await driver.read('a')).toEqual({})
    expect(await driver.read('c')).toEqual({})
    expect(await driver.read('d')).toEqual({})
  })

  it('does not revive an expired session on touch', async () => {
    const driver = new MemoryDriver()
    await driver.write('gone', { a: 1 }, -1)
    await driver.touch('gone', 60)
    expect(await driver.read('gone')).toBe(null)
  })
})

describe('ream > session cookie attributes come from the config', () => {
  for (const store of ['memory', 'cookie'] as const) {
    describe(`${store} store`, () => {
      const base = { store, secret: '0'.repeat(32) }

      it('keeps the defaults: path /, HttpOnly, SameSite=Lax, not Secure outside production', async () => {
        vi.stubEnv('NODE_ENV', 'development')
        const attrs = attributes(await sessionCookie(base))
        expect(attrs).toContain('path=/')
        expect(attrs).toContain('httponly')
        expect(attrs).toContain('samesite=lax')
        expect(attrs).not.toContain('secure')
        expect(attrs.some((a) => a.startsWith('domain='))).toBe(false)
      })

      it('is Secure by default in production', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        expect(attributes(await sessionCookie(base))).toContain('secure')
      })

      it('applies sameSite, domain and path from the config', async () => {
        const attrs = attributes(
          await sessionCookie({
            ...base,
            cookie: { sameSite: 'strict', domain: 'example.test', path: '/app' },
          }),
        )
        expect(attrs).toContain('samesite=strict')
        expect(attrs).toContain('domain=example.test')
        expect(attrs).toContain('path=/app')
        expect(attrs).toContain('httponly')
      })

      it('forces Secure on a staging host that does not run as production', async () => {
        vi.stubEnv('NODE_ENV', 'staging')
        expect(attributes(await sessionCookie({ ...base, cookie: { secure: true } }))).toContain(
          'secure',
        )
      })

      it('lets a production app reached over plain HTTP turn Secure off', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        expect(
          attributes(await sessionCookie({ ...base, cookie: { secure: false } })),
        ).not.toContain('secure')
      })

      it('keeps the lifetime from age, not from the cookie options', async () => {
        const attrs = attributes(await sessionCookie({ ...base, maxAge: 600 }))
        expect(attrs).toContain('max-age=600')
      })
    })
  }

  it('refuses httpOnly: false', () => {
    expect(() => new SessionMiddleware({ store: 'memory', cookie: { httpOnly: false } })).toThrow(
      E_SESSION_COOKIE_NOT_HTTP_ONLY,
    )
  })
})

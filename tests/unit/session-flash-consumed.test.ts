/**
 * A flash bag was moved out of the session in memory only, without marking it
 * modified, so a request that just READ the session touched the store instead
 * of writing it back and the bag came back on every following page. Upstream
 * (`@adonisjs/session` 8.3.0 `initiate`) `pull`s the flash key, which marks
 * the store modified: flash data lives for exactly one following request.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import { MemoryDriver } from '../../src/session/drivers/MemoryDriver.js'
import { Session } from '../../src/session/Session.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

const TTL = 3600

async function seated(driver: MemoryDriver): Promise<Session> {
  const session = new Session('sess-1')
  session.setStore(driver, { fresh: false, ttl: TTL })
  await session.initiate()
  return session
}

describe('flash messages > consumed by the next request', () => {
  it('lives for exactly one following request (memory store, Session lifecycle)', async () => {
    const driver = new MemoryDriver()
    const first = new Session('sess-1')
    first.setStore(driver, { fresh: true, ttl: TTL })
    await first.initiate()
    first.put('user', 1)
    first.flash('notice', 'Saved!')
    await first.commit()

    const second = await seated(driver)
    expect(second.flashMessages.get('notice')).toBe('Saved!')
    expect(second.isDirty()).toBe(true)
    await second.commit()

    const third = await seated(driver)
    expect(third.flashMessages.get('notice')).toBeUndefined()
    expect(third.get('user')).toBe(1)
    await third.commit()
  })

  it('leaves a session without a flash bag untouched', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', { user: 1 }, TTL)

    const session = await seated(driver)
    expect(session.isDirty()).toBe(false)
  })
})

describe('flash messages > through the session middleware', () => {
  const signer = new CookieSigner('test-app-key-32-bytes-long-xxxxxx')

  function request(cookie: string | undefined): HttpContext {
    const headers: Record<string, string> = { host: 'app.test' }
    if (cookie) headers.cookie = cookie
    const ctx = new HttpContext(
      'test',
      { method: 'GET', path: '/', query: '', headers, body: '' },
      {},
      { pattern: '/', middleware: [] },
    )
    ctx.setCookieSigner(signer)
    return ctx
  }

  function sessionCookie(ctx: HttpContext): string | undefined {
    return (ctx.response.getHeaders()['set-cookie'] ?? '')
      .split('\n')
      .map((line) => line.split(';')[0] ?? '')
      .find((pair) => pair.startsWith('ream_session='))
  }

  for (const store of ['memory', 'cookie'] as const) {
    it(`shows a flash once, then never again (${store} store)`, async () => {
      const middleware = new SessionMiddleware({
        store,
        cookieName: 'ream_session',
        maxAge: TTL,
        secret: 'a-session-secret-of-32-characters!!',
      })

      const save = request(undefined)
      await middleware.handle(save, async () => {
        save.session?.put('user', 1)
        save.session?.flash('notice', 'Saved!')
      })
      let cookie = sessionCookie(save)
      expect(cookie).toBeDefined()

      const seen: unknown[] = []
      for (let i = 0; i < 3; i++) {
        const view = request(cookie)
        await middleware.handle(view, async () => {
          seen.push(view.session?.flashMessages.get('notice'))
          expect(view.session?.get('user')).toBe(1)
        })
        // The cookie store carries the session itself, so a re-emitted cookie
        // replaces the one the browser holds.
        cookie = sessionCookie(view) ?? cookie
      }

      expect(seen).toEqual(['Saved!', undefined, undefined])
    })
  }
})

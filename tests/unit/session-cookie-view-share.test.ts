/**
 * The cookie driver set `ctx.session` but never shared it with the view, so
 * `{{ flashMessages… }}` and the `@error` / `@errors` / `@inputError` tags saw
 * nothing at all — a form silently lost every validation message, but only
 * under that one driver.
 */
import { describe, expect, it } from 'vitest'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

function makeCtx() {
  const data = new Map<string, unknown>()
  const shared: Record<string, unknown> = {}
  return {
    ctx: {
      request: {
        header: () => undefined,
        cookie: () => null,
        plainCookie: () => null,
      },
      response: {
        cookie() {},
        plainCookie() {},
      },
      store: {
        get: <T>(key: string) => data.get(key) as T | undefined,
        set: (key: string, value: unknown) => {
          data.set(key, value)
        },
      },
      view: {
        share(values: Record<string, unknown>) {
          Object.assign(shared, values)
        },
      },
    },
    shared,
  }
}

const middleware = (driver: 'cookie' | 'memory') =>
  new SessionMiddleware({
    driver,
    cookieName: 'ream_session',
    maxAge: 3600,
    secret: '0'.repeat(32),
  })

describe('ream > session shared with the view', () => {
  it('shares under the cookie driver', async () => {
    const { ctx, shared } = makeCtx()
    await middleware('cookie').handle(ctx as never, async () => {})
    expect(Object.keys(shared)).toEqual(expect.arrayContaining(['session', 'flashMessages', 'old']))
  })

  it('shares under a server-side driver too', async () => {
    const { ctx, shared } = makeCtx()
    await middleware('memory').handle(ctx as never, async () => {})
    expect(Object.keys(shared)).toEqual(expect.arrayContaining(['session', 'flashMessages', 'old']))
  })
})

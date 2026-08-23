/**
 * AdonisJS writes `config/session.ts` as `{ store, stores, age: '2h' }`. ream
 * read `driver` and `maxAge` in seconds, so a migrated config selected no store
 * and carried no lifetime.
 */
import { describe, expect, it } from 'vitest'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

function makeCtx() {
  const data = new Map<string, unknown>()
  return {
    request: {
      header: () => undefined,
      cookie: () => null,
      plainCookie: () => null,
      original: () => ({}),
    },
    response: { cookie() {}, plainCookie() {} },
    store: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      set: (key: string, value: unknown) => {
        data.set(key, value)
      },
    },
  }
}

describe('ream > session config', () => {
  it('takes the AdonisJS store + stores shape', async () => {
    const middleware = new SessionMiddleware({
      store: 'memory',
      stores: { memory: { driver: 'memory' } },
      age: '2h',
    })
    const ctx = makeCtx()
    await middleware.handle(ctx as never, async () => {})
    expect(ctx.store.get('session')).toBeDefined()
  })

  it("still takes ream's driver + maxAge", async () => {
    const middleware = new SessionMiddleware({ driver: 'memory', maxAge: 7200 })
    const ctx = makeCtx()
    await middleware.handle(ctx as never, async () => {})
    expect(ctx.store.get('session')).toBeDefined()
  })

  it('reads a duration string for the lifetime', () => {
    // A lifetime silently read as NaN would expire every session at once.
    expect(() => new SessionMiddleware({ store: 'memory', age: '30m' })).not.toThrow()
    expect(() => new SessionMiddleware({ store: 'memory', age: 'soon' })).toThrow(
      /Cannot read "soon" as a session age/,
    )
  })

  it('resolves the driver named by the selected store', () => {
    expect(
      () =>
        new SessionMiddleware({
          store: 'primary',
          stores: { primary: { driver: 'memory' } },
        }),
    ).not.toThrow()
  })
})

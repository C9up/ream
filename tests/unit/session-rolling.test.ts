import { beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '../../src/session/Session.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

/** Narrow away null/undefined without a `!` non-null assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a defined session in the store')
  return value
}

interface FakeStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
}

interface FakeCtx {
  request: {
    header(name: string): string | undefined
    cookie(name: string): string | null
  }
  response: {
    cookies: string[]
    cookie(name: string, value: string, opts?: Record<string, unknown>): void
  }
  store: FakeStore
}

function makeCtx(cookieHeader?: string): FakeCtx {
  const data = new Map<string, unknown>()
  // Parse the test fixture's cookie header once so the mock matches the
  // production `Request.cookie(name)` accessor — the middleware no longer
  // touches `header('cookie')` directly.
  const cookies: Record<string, string> = {}
  for (const pair of (cookieHeader ?? '').split(';')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    cookies[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
  }
  return {
    request: {
      header: (name) => (name === 'cookie' ? cookieHeader : undefined),
      cookie: (name) => cookies[name] ?? null,
    },
    response: {
      cookies: [],
      cookie(name, value) {
        this.cookies.push(`${name}=${value}`)
      },
    },
    store: {
      get<T>(key: string) {
        return data.get(key) as T | undefined
      },
      set(key: string, value: unknown) {
        data.set(key, value)
      },
    },
  }
}

describe('SessionMiddleware > server-side driver (memory)', () => {
  let mw: SessionMiddleware

  beforeEach(() => {
    mw = new SessionMiddleware({ driver: 'memory', cookieName: 'rs', maxAge: 60 })
  })

  it('does not re-emit Set-Cookie on a read-only request with an existing session (rolling=false)', async () => {
    // Seed a session via a dirtying request first.
    const seed = makeCtx()
    await mw.handle(seed as never, async () => {
      const s = defined(seed.store.get<Session>('session'))
      s.put('user', 'alice')
    })
    expect(seed.response.cookies.length).toBe(1)
    const cookie = seed.response.cookies[0]
    const sessionId = cookie.split('=')[1]

    // Subsequent read-only request should NOT re-emit the cookie by default.
    const ro = makeCtx(`rs=${sessionId}`)
    await mw.handle(ro as never, async () => {
      defined(ro.store.get<Session>('session')).get('user')
    })
    expect(ro.response.cookies.length).toBe(0)
  })

  it('re-emits Set-Cookie on a read-only request when rolling=true', async () => {
    mw = new SessionMiddleware({
      driver: 'memory',
      cookieName: 'rs',
      maxAge: 60,
      rolling: true,
    })

    const seed = makeCtx()
    await mw.handle(seed as never, async () => {
      defined(seed.store.get<Session>('session')).put('user', 'alice')
    })
    const sessionId = seed.response.cookies[0].split('=')[1]

    const ro = makeCtx(`rs=${sessionId}`)
    await mw.handle(ro as never, async () => {
      defined(ro.store.get<Session>('session')).get('user')
    })
    expect(ro.response.cookies.length).toBe(1)
    expect(ro.response.cookies[0]).toContain(`rs=${sessionId}`)
  })

  it('does NOT emit Set-Cookie on a brand-new CLEAN request (no anonymous tracking id)', async () => {
    // A first read-only hit that never writes to the session must not
    // receive a cookie: there's no server-side row to point at (touch()
    // is a no-op without a backing entry), and a persistent anonymous
    // id would defeat HTTP caching + leak a tracking cookie to CDNs.
    const ctx = makeCtx()
    await mw.handle(ctx as never, async () => {
      // read-only handler — session stays clean
    })
    expect(ctx.response.cookies.length).toBe(0)
  })

  it('DOES emit Set-Cookie on a brand-new request that writes to the session', async () => {
    const ctx = makeCtx()
    await mw.handle(ctx as never, async () => {
      defined(ctx.store.get<Session>('session')).put('cart', 'item-1')
    })
    expect(ctx.response.cookies.length).toBe(1)
  })

  it('regenerate() during the request mints a new id in the cookie + destroys the old driver entry', async () => {
    // Seed a session under id A.
    const seed = makeCtx()
    await mw.handle(seed as never, async () => {
      defined(seed.store.get<Session>('session')).put('user', 'alice')
    })
    const oldId = seed.response.cookies[0].split('=')[1]

    // Second request: simulate login (call regenerate()). The middleware
    // must migrate the driver entry to the new id AND emit the new cookie.
    const login = makeCtx(`rs=${oldId}`)
    let newId = ''
    await mw.handle(login as never, async () => {
      const s = defined(login.store.get<Session>('session'))
      s.regenerate()
      s.put('auth_user_id', 'alice')
      newId = s.sessionId
    })
    expect(newId).not.toBe(oldId)
    // Response cookie carries the NEW id.
    expect(login.response.cookies.length).toBe(1)
    expect(login.response.cookies[0]).toContain(`rs=${newId}`)

    // Subsequent request with the OLD id should NOT find the user data
    // (the old driver entry was destroyed) — this is the fixation
    // mitigation: an attacker who held the pre-login cookie loses access.
    const stale = makeCtx(`rs=${oldId}`)
    await mw.handle(stale as never, async () => {
      const s = defined(stale.store.get<Session>('session'))
      expect(s.get('auth_user_id')).toBeUndefined()
    })

    // The new id should still resolve to the authenticated user.
    const ok = makeCtx(`rs=${newId}`)
    await mw.handle(ok as never, async () => {
      const s = defined(ok.store.get<Session>('session'))
      expect(s.get('auth_user_id')).toBe('alice')
    })
  })
})

describe('Session > regenerate() unit', () => {
  it('rotates sessionId, marks dirty, preserves data, exposes originalSessionId', async () => {
    const { Session } = await import('../../src/session/Session.js')
    const s = new Session('original-id', { existing: 'value' })
    expect(s.sessionId).toBe('original-id')
    expect(s.wasRegenerated()).toBe(false)
    expect(s.isDirty()).toBe(false)

    s.regenerate()

    expect(s.sessionId).not.toBe('original-id')
    // base64url shape: 32 bytes → ~43 chars, no padding, no +/.
    expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{40,48}$/)
    expect(s.originalSessionId()).toBe('original-id')
    expect(s.wasRegenerated()).toBe(true)
    expect(s.isDirty()).toBe(true)
    // Existing data preserved across rotation.
    expect(s.get('existing')).toBe('value')
  })

  it('each regenerate() call produces a fresh id (no collision / no reuse)', async () => {
    const { Session } = await import('../../src/session/Session.js')
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const s = new Session('seed')
      s.regenerate()
      ids.add(s.sessionId)
    }
    expect(ids.size).toBe(50)
  })
})

describe('SessionMiddleware > cookie driver', () => {
  it('emits Set-Cookie on every read-only request when rolling=true (cookie driver)', async () => {
    const mw = new SessionMiddleware({
      driver: 'cookie',
      secret: 'a'.repeat(32),
      cookieName: 'rs',
      maxAge: 60,
      rolling: true,
    })

    // Seed: dirty write to obtain an encrypted cookie value.
    const seed = makeCtx()
    await mw.handle(seed as never, async () => {
      defined(seed.store.get<Session>('session')).put('user', 'bob')
    })
    expect(seed.response.cookies.length).toBe(1)
    const seedCookie = seed.response.cookies[0]
    const encrypted = seedCookie.slice('rs='.length)

    // Read-only with the encrypted cookie present.
    const ro = makeCtx(`rs=${encrypted}`)
    await mw.handle(ro as never, async () => {
      // no mutation
    })
    expect(ro.response.cookies.length).toBe(1)
  })

  it('does NOT emit Set-Cookie on a read-only request by default (cookie driver, rolling=false)', async () => {
    const mw = new SessionMiddleware({
      driver: 'cookie',
      secret: 'a'.repeat(32),
      cookieName: 'rs',
      maxAge: 60,
    })

    const seed = makeCtx()
    await mw.handle(seed as never, async () => {
      defined(seed.store.get<Session>('session')).put('user', 'bob')
    })
    const encrypted = seed.response.cookies[0].slice('rs='.length)

    const ro = makeCtx(`rs=${encrypted}`)
    await mw.handle(ro as never, async () => {
      // no mutation
    })
    expect(ro.response.cookies.length).toBe(0)
  })

  it('does NOT emit Set-Cookie on a request without any incoming cookie when rolling=true (cookie driver)', async () => {
    // No incoming cookie means no session to roll. Avoids leaking an empty
    // encrypted cookie on every anonymous GET in rolling mode.
    const mw = new SessionMiddleware({
      driver: 'cookie',
      secret: 'a'.repeat(32),
      cookieName: 'rs',
      maxAge: 60,
      rolling: true,
    })

    const ctx = makeCtx()
    await mw.handle(ctx as never, async () => {
      // no mutation
    })
    expect(ctx.response.cookies.length).toBe(0)
  })
})

/**
 * A logout holds against requests that were already running, and against a
 * cookie copied before it.
 *
 * Two upstream behaviours undid it. A request that came in before the logout
 * and went out after it wrote back the copy of the session it had read —
 * user id included — so the browser's last `Set-Cookie`, or the store's last
 * write, was the logged-in one. And the cookie driver's value carried no
 * expiry the server checked: a copy stayed valid for as long as the key did.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import { Session } from '../../src/session/Session.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

const SECRET = 'a-secret-long-enough-for-the-cookie-driver'

interface FakeCtx {
  request: {
    header(name: string): string | undefined
    cookie(name: string): string | null
    plainCookie(name: string): string | null
    original(): Record<string, unknown>
  }
  response: {
    cookies: string[]
    cookie(name: string, value: string): void
    plainCookie(name: string, value: string): void
  }
  store: Map<string, unknown>
  session?: unknown
}

function makeCtx(value?: string): FakeCtx {
  return {
    request: {
      header: () => undefined,
      cookie: () => value ?? null,
      plainCookie: () => value ?? null,
      original: () => ({}),
    },
    response: {
      cookies: [],
      cookie(_name, next) {
        this.cookies.push(next)
      },
      plainCookie(_name, next) {
        this.cookies.push(next)
      },
    },
    store: new Map(),
  }
}

function sessionOf(ctx: FakeCtx): Session {
  const session = ctx.store.get('session')
  if (!(session instanceof Session)) throw new Error('no session on the context')
  return session
}

function lastCookie(ctx: FakeCtx): string {
  const value = ctx.response.cookies.at(-1)
  if (value === undefined) throw new Error('no Set-Cookie')
  return value
}

/** What a request carrying `value` sees under the user key. */
async function userBehind(mw: SessionMiddleware, value: string): Promise<unknown> {
  const ctx = makeCtx(value)
  let user: unknown
  await mw.handle(ctx as never, async () => {
    user = sessionOf(ctx).get('user')
  })
  return user
}

/** What warden's `logout()` does to the session. */
function logout(session: Session): void {
  session.forget('user')
  session.regenerate()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('session > a request in flight across a logout (memory driver)', () => {
  it('does not write the logged-in copy back, nor hand out its id', async () => {
    const mw = new SessionMiddleware({ driver: 'memory', maxAge: 600 })
    const login = makeCtx()
    await mw.handle(login as never, async () => {
      sessionOf(login).put('user', 7)
    })
    const id = lastCookie(login)

    let release = (): void => {}
    const slow = makeCtx(id)
    const slowDone = mw.handle(slow as never, async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      // A limiter counter, a flash message: anything that dirties it.
      sessionOf(slow).put('throttle', 1)
    })

    const out = makeCtx(id)
    await mw.handle(out as never, async () => {
      logout(sessionOf(out))
    })
    const afterLogout = lastCookie(out)
    expect(afterLogout).not.toBe(id)

    release()
    await slowDone

    expect(await userBehind(mw, id)).toBeUndefined()
    expect(await userBehind(mw, afterLogout)).toBeUndefined()
    // The browser keeps the cookie the logout gave it.
    expect(slow.response.cookies).toEqual([])
  })

  it('keeps refusing the pre-logout id when it is replayed', async () => {
    const mw = new SessionMiddleware({ driver: 'memory', maxAge: 600 })
    const login = makeCtx()
    await mw.handle(login as never, async () => {
      sessionOf(login).put('user', 7)
    })
    const copied = lastCookie(login)

    const out = makeCtx(copied)
    await mw.handle(out as never, async () => {
      logout(sessionOf(out))
    })

    expect(await userBehind(mw, copied)).toBeUndefined()
  })
})

describe('session > the cookie driver checks its own expiry', () => {
  it('refuses a copy older than the session lifetime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
    const mw = new SessionMiddleware({ driver: 'cookie', secret: SECRET, maxAge: 600 })
    const login = makeCtx()
    await mw.handle(login as never, async () => {
      sessionOf(login).put('user', 7)
    })
    const copied = lastCookie(login)
    expect(await userBehind(mw, copied)).toBe(7)

    // The browser would have dropped it at max-age; a copy does not have to.
    vi.setSystemTime(new Date('2026-10-23T08:10:01Z'))
    expect(await userBehind(mw, copied)).toBeUndefined()
  })

  it('slides the expiry forward with each rolling re-emission', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
    const mw = new SessionMiddleware({
      driver: 'cookie',
      secret: SECRET,
      maxAge: 600,
      rolling: true,
    })
    const login = makeCtx()
    await mw.handle(login as never, async () => {
      sessionOf(login).put('user', 7)
    })

    vi.setSystemTime(new Date('2026-10-23T08:09:00Z'))
    const active = makeCtx(lastCookie(login))
    await mw.handle(active as never, async () => {})

    vi.setSystemTime(new Date('2026-10-23T08:15:00Z'))
    expect(await userBehind(mw, lastCookie(active))).toBe(7)
  })

  it('counts a re-emitted lifetime from when the request read the session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
    const mw = new SessionMiddleware({
      driver: 'cookie',
      secret: SECRET,
      maxAge: 600,
      rolling: true,
    })
    const login = makeCtx()
    await mw.handle(login as never, async () => {
      sessionOf(login).put('user', 7)
    })

    // Read at 08:01, answered at 08:06: the copy it hands back is good until
    // 08:11, not 08:16.
    vi.setSystemTime(new Date('2026-10-23T08:01:00Z'))
    const slow = makeCtx(lastCookie(login))
    await mw.handle(slow as never, async () => {
      vi.setSystemTime(new Date('2026-10-23T08:06:00Z'))
    })
    vi.setSystemTime(new Date('2026-10-23T08:10:59Z'))
    expect(await userBehind(mw, lastCookie(slow))).toBe(7)
    vi.setSystemTime(new Date('2026-10-23T08:11:01Z'))
    expect(await userBehind(mw, lastCookie(slow))).toBeUndefined()
  })

  it('re-sends nothing from a request that outlasted the session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
    const mw = new SessionMiddleware({
      driver: 'cookie',
      secret: SECRET,
      maxAge: 600,
      rolling: true,
    })
    const login = makeCtx()
    await mw.handle(login as never, async () => {
      sessionOf(login).put('user', 7)
    })

    const slow = makeCtx(lastCookie(login))
    await mw.handle(slow as never, async () => {
      vi.setSystemTime(new Date('2026-10-23T08:10:01Z'))
      sessionOf(slow).put('throttle', 1)
    })
    // The browser keeps the cookie it holds — after a logout, the signed-out one.
    expect(slow.response.cookies).toEqual([])
  })

  it('gives a session regenerated during the request its whole lifetime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
    const mw = new SessionMiddleware({ driver: 'cookie', secret: SECRET, maxAge: 600 })
    const visit = makeCtx()
    await mw.handle(visit as never, async () => {
      sessionOf(visit).put('visited', true)
    })

    const login = makeCtx(lastCookie(visit))
    await mw.handle(login as never, async () => {
      vi.setSystemTime(new Date('2026-10-23T08:05:00Z'))
      sessionOf(login).regenerate()
      sessionOf(login).put('user', 7)
    })
    vi.setSystemTime(new Date('2026-10-23T08:14:00Z'))
    expect(await userBehind(mw, lastCookie(login))).toBe(7)
  })

  it('refuses a value encrypted for another cookie under the same key', async () => {
    const mw = new SessionMiddleware({ driver: 'cookie', secret: SECRET, maxAge: 600 })
    const forged = new CookieSigner(SECRET).encrypt(
      JSON.stringify({ user: 7 }),
      600_000,
      'remember_web',
    )
    expect(await userBehind(mw, forged)).toBeUndefined()
  })

  it('refuses a value sealed without an expiry, as the driver used to write', async () => {
    const mw = new SessionMiddleware({ driver: 'cookie', secret: SECRET, maxAge: 600 })
    const legacy = new CookieSigner(SECRET).encrypt(JSON.stringify({ user: 7 }))
    expect(await userBehind(mw, legacy)).toBeUndefined()
  })
})

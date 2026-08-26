/**
 * The server-side session id travels in a SIGNED cookie, as it does in
 * AdonisJS (`response.cookie(cookieName, sessionId, …)`).
 *
 * It used to go out through `plainCookie`. The id is 192 bits of entropy so it
 * was never guessable — what the signature buys is that a cookie the app did
 * not issue is refused on READ, before any store lookup, and that an id minted
 * under a different APP_KEY cannot be presented. The cookie DRIVER is a
 * separate case: its value is its own aes-256-gcm ciphertext, so the driver
 * already authenticates it and it stays raw.
 */

import { describe, expect, it } from 'vitest'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

interface WriteCall {
  kind: 'signed' | 'plain'
  name: string
  value: string
}

function makeCtx(incoming: { signed?: string | null; plain?: string | null } = {}) {
  const writes: WriteCall[] = []
  const store = new Map<string, unknown>()
  const ctx = {
    request: {
      header: () => undefined,
      // What `request.cookie()` returns: null when the HMAC does not verify.
      cookie: () => incoming.signed ?? null,
      plainCookie: () => incoming.plain ?? null,
      original: () => ({}),
    },
    response: {
      cookie(name: string, value: string) {
        writes.push({ kind: 'signed', name, value })
      },
      plainCookie(name: string, value: string) {
        writes.push({ kind: 'plain', name, value })
      },
    },
    store: {
      get: <T>(k: string) => store.get(k) as T | undefined,
      set: (k: string, v: unknown) => {
        store.set(k, v)
      },
    },
  }
  return { ctx, writes, store }
}

const middleware = (driver: 'cookie' | 'memory') =>
  new SessionMiddleware({
    driver,
    cookieName: 'ream_session',
    maxAge: 3600,
    secret: '0'.repeat(32),
  })

type Session = { put(k: string, v: unknown): void }

describe('ream > the session cookie is signed', () => {
  it('writes the server-side id through the SIGNED cookie', async () => {
    const { ctx, writes, store } = makeCtx()

    await middleware('memory').handle(ctx as never, async () => {
      ;(store.get('session') as Session).put('user', 1)
    })

    const written = writes.find((w) => w.name === 'ream_session')
    expect(written?.kind).toBe('signed')
  })

  it('keeps the cookie driver raw — its payload authenticates itself', async () => {
    // aes-256-gcm is an AEAD: signing the ciphertext again would only make the
    // cookie bigger.
    const { ctx, writes, store } = makeCtx()

    await middleware('cookie').handle(ctx as never, async () => {
      ;(store.get('session') as Session).put('user', 1)
    })

    expect(writes.find((w) => w.name === 'ream_session')?.kind).toBe('plain')
  })

  it('refuses an id whose signature does not verify, before touching the store', async () => {
    // `request.cookie()` returns null for a forged or foreign cookie, so the
    // request starts a fresh session rather than probing the store with it.
    const { ctx, store } = makeCtx({ signed: null, plain: 'planted-session-id' })

    await middleware('memory').handle(ctx as never, async () => {})

    const session = store.get('session') as { sessionId: string }
    expect(session.sessionId).not.toBe('planted-session-id')
  })

  it('accepts an id whose signature verifies', async () => {
    const { ctx, store } = makeCtx({ signed: 'legitimate-session-id' })

    await middleware('memory').handle(ctx as never, async () => {})

    expect((store.get('session') as { sessionId: string }).sessionId).toBe('legitimate-session-id')
  })
})

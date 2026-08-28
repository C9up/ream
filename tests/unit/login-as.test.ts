/**
 * `loginAs(guard, user)` — AdonisJS's test seam. Its helix plugin calls
 * `guard.authenticateAsClient(...)`, so the GUARD says what to send. Without
 * it, every authenticated test in a migrated suite has to forge its own header
 * — which proves the forgery works, not the app.
 */
import { describe, expect, it } from 'vitest'
import { RequestBuilder } from '../../src/testing/RequestBuilder.js'

function capture() {
  const seen: { headers?: Record<string, string>; cookies?: string } = {}
  const sender = async (
    _method: string,
    _path: string,
    init: { headers: Record<string, string> },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    seen.headers = init.headers
    seen.cookies = init.headers.cookie
    return { status: 200, headers: {}, body: '{}' }
  }
  return { sender: sender as never, seen }
}

describe('ream > loginAs', () => {
  it('sends the header a token guard answers with', async () => {
    const { sender, seen } = capture()
    const guard = {
      authenticateAsClient: () => ({
        headers: { authorization: 'Bearer signed.jwt' },
      }),
    }
    await new RequestBuilder(sender, 'GET', '/me').loginAs(guard as never)
    expect(seen.headers?.authorization).toBe('Bearer signed.jwt')
  })

  it('sends the cookies a guard answers with', async () => {
    const { sender, seen } = capture()
    const guard = {
      authenticateAsClient: () => ({ cookies: { remember_me: 'abc' } }),
    }
    await new RequestBuilder(sender, 'GET', '/me').loginAs(guard as never)
    expect(seen.cookies).toContain('remember_me=abc')
  })

  it('awaits a guard that answers asynchronously', async () => {
    const { sender, seen } = capture()
    const guard = {
      authenticateAsClient: async () => ({ headers: { 'x-api-key': 'k' } }),
    }
    await new RequestBuilder(sender, 'GET', '/me').loginAs(guard as never)
    expect(seen.headers?.['x-api-key']).toBe('k')
  })

  it("seeds a session guard's values through the configured seeder", async () => {
    const { sender, seen } = capture()
    const guard = {
      authenticateAsClient: () => ({ session: { auth_user_id: 42 } }),
    }
    const seeded: Array<Record<string, unknown>> = []
    const seeder = async (values: Record<string, unknown>) => {
      seeded.push(values)
      return { ream_session: 'sid-1' }
    }
    await new RequestBuilder(sender, 'GET', '/me', null, seeder).loginAs(guard as never)
    expect(seeded).toEqual([{ auth_user_id: 42 }])
    expect(seen.cookies).toContain('ream_session=sid-1')
  })

  it('says so when a session guard is used with no seeder', async () => {
    const { sender } = capture()
    const guard = {
      authenticateAsClient: () => ({ session: { auth_user_id: 42 } }),
    }
    // Silently dropping it would send the request unauthenticated and the
    // test would fail far from the cause.
    await expect(new RequestBuilder(sender, 'GET', '/me').loginAs(guard as never)).rejects.toThrow(
      /needs a session to be written/,
    )
  })

  it('passes extra arguments through, as basic auth needs', async () => {
    const { sender, seen } = capture()
    const guard = {
      authenticateAsClient: (uid: string, password: string) => ({
        headers: {
          authorization: `Basic ${Buffer.from(`${uid}:${password}`).toString('base64')}`,
        },
      }),
    }
    await new RequestBuilder(sender, 'GET', '/admin').loginAs(
      guard as never,
      'ada' as never,
      'secret' as never,
    )
    expect(
      Buffer.from((seen.headers?.authorization ?? '').replace('Basic ', ''), 'base64').toString(),
    ).toBe('ada:secret')
  })
})

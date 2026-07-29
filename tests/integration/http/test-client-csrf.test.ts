import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestClient } from '../../../src/testing/TestClient.js'
import { HyperServer } from './loader.js'

/**
 * End-to-end proof that the TestClient's `.withCsrf()` satisfies a signed
 * double-submit CSRF check, and that `.visit()` resolves a named route against
 * a manifest. The server here enforces the *contract* blackhole enforces on an
 * unsafe verb (cookie token must equal the echoed header token) without
 * booting the full blackhole middleware — the value under test is what the
 * client wires (cookie → X-XSRF-TOKEN header), not the HMAC verification, which
 * is blackhole-engine's own tested concern.
 */
const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

interface NapiRequest {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
}

const ISSUED_TOKEN = 'random32.hmacsignature'

/** Read one cookie value out of a `Cookie:` header (`a=1; XSRF-TOKEN=xyz`). */
function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const pair of cookieHeader.split(';')) {
    const [k, ...rest] = pair.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return undefined
}

async function handler(req: NapiRequest): Promise<{
  status: number
  headers: Record<string, string>
  body: string
}> {
  // Issue the signed token in the XSRF-TOKEN cookie on a safe GET.
  if (req.method === 'GET' && req.path === '/csrf-token') {
    return {
      status: 200,
      headers: { 'set-cookie': `XSRF-TOKEN=${ISSUED_TOKEN}; Path=/; SameSite=Lax` },
      body: JSON.stringify({ token: ISSUED_TOKEN }),
    }
  }

  // Unsafe verb — enforce the double-submit: cookie token must equal the header.
  if (req.method === 'POST' && req.path === '/protected') {
    const cookieToken = readCookie(req.headers.cookie, 'XSRF-TOKEN')
    const headerToken = req.headers['x-xsrf-token']
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return { status: 403, headers: {}, body: JSON.stringify({ error: 'EBADCSRFTOKEN' }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) }
  }

  // Any GET — echo the resolved path (used by the visit() test).
  return { status: 200, headers: {}, body: JSON.stringify({ path: req.path }) }
}

describeIfNetwork('TestClient > withCsrf + visit (real HyperServer)', () => {
  let client: TestClient

  beforeAll(async () => {
    client = new TestClient(
      async () => {
        const s = new HyperServer(0)
        s.onRequest(handler)
        await s.listen()
        return { port: await s.port(), close: () => s.close() }
      },
      { routes: { 'users.show': '/users/:id', home: '/' } },
    )
    await client.boot()
  })

  afterAll(async () => {
    await client.close()
  })

  it('a protected POST without withCsrf() is rejected (403)', async () => {
    await client.fluent('POST', '/protected').json({ name: 'x' }).assertForbidden()
  })

  it('a protected POST WITH withCsrf() succeeds (200)', async () => {
    // Obtain the signed token the server issues on a safe GET.
    const issued = await client.fluent('GET', '/csrf-token').send()
    const setCookie = issued.headers['set-cookie'] ?? ''
    const token = setCookie.split(';')[0]?.split('=')[1] ?? ''
    expect(token).toBe(ISSUED_TOKEN)

    await client
      .fluent('POST', '/protected')
      .cookie('XSRF-TOKEN', token)
      .withCsrf()
      .json({ name: 'x' })
      .assertOk()
      .assertBodyContains({ ok: true })
  })

  it('visit() resolves a named route and GETs it', async () => {
    await client
      .visit('users.show', { id: '7' })
      .assertOk()
      .assertBodyContains({ path: '/users/7' })
  })
})

import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  type AuthStrategy,
  partialMatch,
  RequestBuilder,
} from '../../src/testing/RequestBuilder.js'
import type { TestResponse } from '../../src/testing/TestClient.js'

const makeResponse = (overrides: Partial<TestResponse> = {}): TestResponse => {
  const body = overrides.body ?? ''
  return {
    status: 200,
    headers: {},
    body,
    bodyBuffer: Buffer.from(body),
    json<T = unknown>(): T {
      return JSON.parse(body) as T
    },
    ...overrides,
  }
}

describe('helix > RequestBuilder', () => {
  it('headers()/header() merge into the outgoing request', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    await builder.headers({ 'X-A': '1', 'X-B': '2' }).header('X-C', '3').send()

    expect(sender).toHaveBeenCalledOnce()
    const init = sender.mock.calls[0][2]
    expect(init.headers['x-a']).toBe('1')
    expect(init.headers['x-b']).toBe('2')
    expect(init.headers['x-c']).toBe('3')
  })

  it('json() sets content-type and serialises body', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.json({ name: 'Ada' }).send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.body.toString('utf8')).toBe('{"name":"Ada"}')
  })

  it('form() emits application/x-www-form-urlencoded', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.form({ a: '1', b: 'two words' }).send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.body.toString('utf8')).toBe('a=1&b=two%20words')
  })

  it('field() emits multipart/form-data with the text field part', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.field('title', 'Hello World').send()

    const init = sender.mock.calls[0][2]
    const ct = init.headers['content-type']
    expect(ct).toMatch(/^multipart\/form-data; boundary=----ReamRequestBuilder/)
    const boundary = ct.split('boundary=')[1]
    const body = init.body.toString('utf8')
    expect(body).toContain(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello World\r\n`,
    )
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })

  it('file() encodes a binary part with filename + content-type; field() interleaves', async () => {
    const sender = vi.fn(async () => makeResponse())
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const builder = new RequestBuilder(sender, 'POST', '/avatar')
    await builder
      .file('avatar', png, { filename: 'a.png', contentType: 'image/png' })
      .field('description', 'my pic')
      .send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toMatch(/^multipart\/form-data/)
    const text = init.body.toString('binary')
    expect(text).toContain('Content-Disposition: form-data; name="avatar"; filename="a.png"')
    expect(text).toContain('Content-Type: image/png')
    expect(text).toContain('Content-Disposition: form-data; name="description"')
    expect(text).toContain('my pic')
    // Raw bytes (incl. embedded CRLF) survive the encoding intact.
    expect(init.body.includes(png)).toBe(true)
  })

  it('file() from a Buffer defaults filename to the field name + octet-stream', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    // A string arg is a PATH now (Japa parity); pass a Buffer for inline content.
    await builder.file('doc', Buffer.from('hello')).send()

    const text = sender.mock.calls[0][2].body.toString('utf8')
    expect(text).toContain('name="doc"; filename="doc"')
    expect(text).toContain('Content-Type: application/octet-stream')
    expect(text).toContain('\r\n\r\nhello\r\n')
  })

  it('multipart parts override a previously-set json body', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.json({ a: 1 }).field('b', '2').send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toMatch(/^multipart\/form-data/)
    expect(init.body.toString('utf8')).not.toContain('{"a":1}')
  })

  it('cookies() serialises to Cookie header', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    await builder.cookies({ s: 'abc', t: 'xyz' }).cookie('u', '1').send()

    const init = sender.mock.calls[0][2]
    expect(init.headers.cookie).toBe('s=abc; t=xyz; u=1')
  })

  it('withAuth() uses the injected AuthStrategy for headers and cookies', async () => {
    const sender = vi.fn(async () => makeResponse())
    const strategy: AuthStrategy = {
      headersFor: async (subject) => ({
        Authorization: `Bearer test-${subject.id}`,
      }),
      cookiesFor: async (subject) => ({ session: `sid-${subject.id}` }),
    }
    const builder = new RequestBuilder(sender, 'GET', '/me', strategy)
    await builder.withAuth({ id: 42 }).send()

    const init = sender.mock.calls[0][2]
    expect(init.headers.authorization).toBe('Bearer test-42')
    expect(init.headers.cookie).toBe('session=sid-42')
  })

  it('asUser() is a shortcut for withAuth({id})', async () => {
    const sender = vi.fn(async () => makeResponse())
    const strategy: AuthStrategy = {
      headersFor: async (s) => ({ 'X-User': String(s.id) }),
    }
    const builder = new RequestBuilder(sender, 'GET', '/me', strategy)
    await builder.asUser('u-99').send()

    expect(sender.mock.calls[0][2].headers['x-user']).toBe('u-99')
  })

  it('withAuth() without an AuthStrategy throws a helpful error', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/x')
    await expect(builder.withAuth({ id: 1 }).send()).rejects.toThrow(/no AuthStrategy was provided/)
  })

  it('send() is memoised — multiple `await`s produce a single call', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    const a = builder.send()
    const b = builder.send()
    await Promise.all([a, b])
    expect(sender).toHaveBeenCalledOnce()
  })

  it('send() returns the response directly (explicit await)', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 201, body: '{"ok":true}' }))
    const builder = new RequestBuilder(sender, 'GET', '/p')
    const res = await builder.send()
    expect(res.status()).toBe(201)
  })

  it('expectStatus() passes when codes match, fails otherwise', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 200 }))
    await expect(new RequestBuilder(sender, 'GET', '/p').expectStatus(200)).resolves.toBeDefined()

    const sender2 = vi.fn(async () => makeResponse({ status: 500, body: 'kaboom' }))
    await expect(new RequestBuilder(sender2, 'GET', '/p').expectStatus(200)).rejects.toThrow(
      /Expected status 200, got 500/,
    )
  })

  it('expectHeader() matches exact strings and RegExp', async () => {
    const sender = vi.fn(async () => makeResponse({ headers: { 'x-trace': 'req-123' } }))
    await new RequestBuilder(sender, 'GET', '/p')
      .expectHeader('x-trace', 'req-123')
      .expectHeader('X-Trace', /^req-/)
  })

  it('expectHeader() throws when header missing or mismatched', async () => {
    const sender = vi.fn(async () => makeResponse({ headers: { 'x-trace': 'abc' } }))
    await expect(
      new RequestBuilder(sender, 'GET', '/p').expectHeader('x-missing', 'x'),
    ).rejects.toThrow(/Expected header x-missing/)
    await expect(
      new RequestBuilder(sender, 'GET', '/p').expectHeader('x-trace', 'xyz'),
    ).rejects.toThrow(/Expected header x-trace = "xyz"/)
  })

  it('expectCookie() parses Set-Cookie and matches', async () => {
    const sender = vi.fn(async () =>
      makeResponse({
        headers: { 'set-cookie': 'session=abc; HttpOnly, theme=dark' },
      }),
    )
    await new RequestBuilder(sender, 'GET', '/p')
      .expectCookie('session', 'abc')
      .expectCookie('theme', /^(dark|light)$/)
      .expectCookie('session')
  })

  it('expectJson() performs partial match', async () => {
    const sender = vi.fn(async () => makeResponse({ body: '{"id":1,"name":"Ada","extra":true}' }))
    await new RequestBuilder(sender, 'GET', '/me').expectJson({
      id: 1,
      name: 'Ada',
    })

    const sender2 = vi.fn(async () => makeResponse({ body: '{"id":1}' }))
    await expect(new RequestBuilder(sender2, 'GET', '/me').expectJson({ id: 2 })).rejects.toThrow(
      /JSON partial match failed/,
    )
  })

  it('assertions chain synchronously and run on a single await', async () => {
    const sender = vi.fn(async () =>
      makeResponse({
        status: 201,
        headers: { 'x-trace': 'xyz' },
        body: '{"id":7}',
      }),
    )
    // Japa model: assertions register + return `this`; the single await sends
    // once and runs them all in order.
    await new RequestBuilder(sender, 'POST', '/u')
      .json({ name: 'Lin' })
      .expectStatus(201)
      .expectHeader('x-trace', 'xyz')
      .expectJson({ id: 7 })
    expect(sender).toHaveBeenCalledOnce()
  })
})

describe('RequestBuilder > qs / auth shortcuts (japa parity)', () => {
  it('qs() appends url-encoded params, repeating keys for arrays', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/search')
      .qs({ q: 'a b', page: 2, tag: ['x', 'y'] })
      .send()

    const path = sender.mock.calls[0][1]
    expect(path).toBe('/search?q=a+b&page=2&tag=x&tag=y')
  })

  it('qs() merges with a query string already on the path', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/search?existing=1').qs({ page: 2 }).send()

    expect(sender.mock.calls[0][1]).toBe('/search?existing=1&page=2')
  })

  it('bearerToken() sets the Authorization header', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/me').bearerToken('tok-123').send()

    expect(sender.mock.calls[0][2].headers.authorization).toBe('Bearer tok-123')
  })

  it('basicAuth() base64-encodes the credentials', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/me').basicAuth('alice', 's3cret').send()

    const expected = `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`
    expect(sender.mock.calls[0][2].headers.authorization).toBe(expected)
  })
})

describe('RequestBuilder > withCsrf (signed double-submit)', () => {
  it('mirrors the XSRF-TOKEN cookie into the X-XSRF-TOKEN header', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/protected')
      .cookie('XSRF-TOKEN', 'signed.token')
      .withCsrf()
      .send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['x-xsrf-token']).toBe('signed.token')
    expect(init.headers.cookie).toBe('XSRF-TOKEN=signed.token')
  })

  it('withCsrf(token) sets both the cookie and the header', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/protected').withCsrf('abc.def').send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['x-xsrf-token']).toBe('abc.def')
    expect(init.headers.cookie).toBe('XSRF-TOKEN=abc.def')
  })

  it('throws when no XSRF-TOKEN cookie is present and no token is passed', () => {
    const sender = vi.fn(async () => makeResponse())
    expect(() => new RequestBuilder(sender, 'POST', '/protected').withCsrf()).toThrow(
      /found no 'XSRF-TOKEN' cookie/,
    )
  })
})

describe('RequestBuilder > status shortcuts', () => {
  const cases: Array<[number, (b: RequestBuilder) => Promise<RequestBuilder>]> = [
    [200, (b) => b.assertOk()],
    [201, (b) => b.assertCreated()],
    [204, (b) => b.assertNoContent()],
    [400, (b) => b.assertBadRequest()],
    [401, (b) => b.assertUnauthorized()],
    [403, (b) => b.assertForbidden()],
    [404, (b) => b.assertNotFound()],
  ]

  for (const [code, run] of cases) {
    it(`passes on ${code} and throws on a mismatch`, async () => {
      const ok = vi.fn(async () => makeResponse({ status: code }))
      await expect(run(new RequestBuilder(ok, 'GET', '/p'))).resolves.toBeDefined()

      const bad = vi.fn(async () => makeResponse({ status: code === 200 ? 500 : 200 }))
      await expect(run(new RequestBuilder(bad, 'GET', '/p'))).rejects.toThrow(/Expected status/)
    })
  }
})

describe('RequestBuilder > assertBodyContains / assertBodyNotContains', () => {
  it('assertBodyContains passes on a present subset, throws when absent', async () => {
    const sender = vi.fn(async () => makeResponse({ body: '{"id":1,"name":"Ada","role":"admin"}' }))
    await new RequestBuilder(sender, 'GET', '/me').assertBodyContains({ name: 'Ada' })

    const sender2 = vi.fn(async () => makeResponse({ body: '{"id":1}' }))
    await expect(
      new RequestBuilder(sender2, 'GET', '/me').assertBodyContains({ name: 'Ada' }),
    ).rejects.toThrow(/Expected body to contain subset/)
  })

  it('assertBodyNotContains passes when absent, throws when the subset is present', async () => {
    const sender = vi.fn(async () => makeResponse({ body: '{"id":1}' }))
    await new RequestBuilder(sender, 'GET', '/me').assertBodyNotContains({ password: 'x' })

    const sender2 = vi.fn(async () => makeResponse({ body: '{"password":"x"}' }))
    await expect(
      new RequestBuilder(sender2, 'GET', '/me').assertBodyNotContains({ password: 'x' }),
    ).rejects.toThrow(/Expected body NOT to contain subset/)
  })
})

describe('RequestBuilder > assertRedirectsTo', () => {
  it('passes on a 3xx with a matching Location pathname (no follow)', async () => {
    const sender = vi.fn(async () =>
      makeResponse({ status: 302, headers: { location: '/dashboard?welcome=1' } }),
    )
    // .redirects(0) so the 3xx is inspected directly (default now follows 5).
    await new RequestBuilder(sender, 'POST', '/login').redirects(0).assertRedirectsTo('/dashboard')
  })

  it('throws when the response is not a redirect', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 200 }))
    await expect(
      new RequestBuilder(sender, 'GET', '/p').redirects(0).assertRedirectsTo('/x'),
    ).rejects.toThrow(/Expected redirect to "\/x"/)
  })

  it('throws when the Location pathname differs', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 301, headers: { location: '/other' } }))
    await expect(
      new RequestBuilder(sender, 'GET', '/p').redirects(0).assertRedirectsTo('/dashboard'),
    ).rejects.toThrow(/Expected redirect to "\/dashboard"/)
  })
})

describe('RequestBuilder > header / cookie presence asserts', () => {
  it('assertHeader checks presence (no value) and value equality', async () => {
    const sender = vi.fn(async () => makeResponse({ headers: { 'x-trace': 'req-1' } }))
    await new RequestBuilder(sender, 'GET', '/p')
      .assertHeader('x-trace')
      .assertHeader('x-trace', 'req-1')

    const sender2 = vi.fn(async () => makeResponse({ headers: {} }))
    await expect(new RequestBuilder(sender2, 'GET', '/p').assertHeader('x-trace')).rejects.toThrow(
      /Expected header x-trace/,
    )
  })

  it('assertHeaderMissing passes when absent, throws when present', async () => {
    const sender = vi.fn(async () => makeResponse({ headers: {} }))
    await new RequestBuilder(sender, 'GET', '/p').assertHeaderMissing('x-deprecated')

    const sender2 = vi.fn(async () => makeResponse({ headers: { 'x-deprecated': '1' } }))
    await expect(
      new RequestBuilder(sender2, 'GET', '/p').assertHeaderMissing('x-deprecated'),
    ).rejects.toThrow(/Expected header x-deprecated to be absent/)
  })

  it('assertCookie / assertCookieMissing read Set-Cookie', async () => {
    const sender = vi.fn(async () =>
      makeResponse({ headers: { 'set-cookie': 'session=abc; HttpOnly' } }),
    )
    await new RequestBuilder(sender, 'GET', '/p')
      .assertCookie('session')
      .assertCookieMissing('theme')

    const sender2 = vi.fn(async () => makeResponse({ headers: { 'set-cookie': 'theme=dark' } }))
    await expect(
      new RequestBuilder(sender2, 'GET', '/p').assertCookieMissing('theme'),
    ).rejects.toThrow(/Expected cookie theme to be absent/)
  })
})

describe('helix > partialMatch', () => {
  it('matches primitives by strict equality', () => {
    expect(partialMatch(1, 1)).toBe(true)
    expect(partialMatch(1, 2)).toBe(false)
    expect(partialMatch('a', 'a')).toBe(true)
    expect(partialMatch(null, null)).toBe(true)
    expect(partialMatch(undefined, undefined)).toBe(true)
  })

  it('matches objects by partial keys', () => {
    expect(partialMatch({ a: 1, b: 2 }, { a: 1 })).toBe(true)
    expect(partialMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(partialMatch({ nested: { x: 1, y: 2 } }, { nested: { x: 1 } })).toBe(true)
  })

  it('matches arrays order-independently (every expected has a match)', () => {
    expect(partialMatch([1, 2, 3], [3, 1])).toBe(true)
    expect(partialMatch([{ id: 1 }, { id: 2 }], [{ id: 2 }])).toBe(true)
    expect(partialMatch([{ id: 1 }], [{ id: 2 }])).toBe(false)
  })
})

describe('helix > RequestBuilder > japa/api-client additions', () => {
  it('type()/accept() expand shorthands into headers', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.type('json').accept('html').send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers.accept).toBe('text/html')
  })

  it('type() passes a full MIME type through unchanged', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/u').type('application/vnd.api+json').send()
    expect(sender.mock.calls[0][2].headers['content-type']).toBe('application/vnd.api+json')
  })

  it('withCsrfToken() aliases withCsrf (sets cookie + echo header)', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/u').withCsrfToken('signed-token').send()
    const init = sender.mock.calls[0][2]
    expect(init.headers['x-xsrf-token']).toBe('signed-token')
    expect(init.headers.cookie).toContain('XSRF-TOKEN=signed-token')
  })

  it('assertStatus() passes on match and throws otherwise', async () => {
    const okSender = vi.fn(async () => makeResponse({ status: 418 }))
    await new RequestBuilder(okSender, 'GET', '/p').assertStatus(418)

    const badSender = vi.fn(async () => makeResponse({ status: 200 }))
    await expect(new RequestBuilder(badSender, 'GET', '/p').assertStatus(418)).rejects.toThrow()
  })

  it('named status shortcuts map to their codes', async () => {
    await new RequestBuilder(
      vi.fn(async () => makeResponse({ status: 422 })),
      'POST',
      '/p',
    ).assertUnprocessableEntity()
    await new RequestBuilder(
      vi.fn(async () => makeResponse({ status: 409 })),
      'POST',
      '/p',
    ).assertConflict()
    await new RequestBuilder(
      vi.fn(async () => makeResponse({ status: 202 })),
      'POST',
      '/p',
    ).assertAccepted()
  })

  it('assertBody() requires EXACT deep equality', async () => {
    const body = JSON.stringify({ id: 1, name: 'Ada' })
    await new RequestBuilder(
      vi.fn(async () => makeResponse({ body })),
      'GET',
      '/p',
    ).assertBody({
      id: 1,
      name: 'Ada',
    })
    // A subset is NOT enough for assertBody (unlike assertBodyContains).
    await expect(
      new RequestBuilder(
        vi.fn(async () => makeResponse({ body })),
        'GET',
        '/p',
      ).assertBody({ id: 1 }),
    ).rejects.toThrow()
  })

  it('assertTextIncludes() checks the raw response text', async () => {
    const sender = vi.fn(async () => makeResponse({ body: '<h1>Welcome Ada</h1>' }))
    await new RequestBuilder(sender, 'GET', '/p').assertTextIncludes('Welcome Ada')
    await expect(
      new RequestBuilder(
        vi.fn(async () => makeResponse({ body: 'nope' })),
        'GET',
        '/p',
      ).assertTextIncludes('Welcome'),
    ).rejects.toThrow()
  })
})

describe('helix > RequestBuilder Japa parity (F7-F9)', () => {
  it('fields() adds several multipart parts', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/u').fields({ a: '1', b: '2' }).send()
    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const text = init.body.toString('utf8')
    expect(text).toContain('name="a"')
    expect(text).toContain('name="b"')
  })

  it('unsafeQs() appends params from an object (Japa signature)', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/s').unsafeQs({ a: 1, b: 'two' }).send()
    expect(sender.mock.calls[0][1]).toBe('/s?a=1&b=two')
  })

  it('timeout() threads the per-request timeout to the sender', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/s').timeout(1234).send()
    expect(sender.mock.calls[0][2].timeoutMs).toBe(1234)
  })

  it('redirects() follows a 3xx Location and records the chain', async () => {
    const sender = vi.fn(async (m: string, p: string) => {
      if (p === '/start') return makeResponse({ status: 302, headers: { location: '/dest' } })
      return makeResponse({ status: 200, body: 'arrived' })
    })
    const res = await new RequestBuilder(sender, 'GET', '/start').redirects(3)
    expect(sender).toHaveBeenCalledTimes(2)
    expect(res.status()).toBe(200)
    expect(res.redirects()).toEqual(['/dest'])
    expect(res.text()).toBe('arrived')
  })

  it('follows up to 5 redirects by DEFAULT (Japa parity)', async () => {
    let hops = 0
    const sender = vi.fn(async () => {
      hops += 1
      // Keep redirecting; the builder must stop after the default budget (5).
      return makeResponse({ status: 302, headers: { location: `/hop${hops}` } })
    })
    const res = await new RequestBuilder(sender, 'GET', '/start')
    // 1 initial + 5 follows = 6 sends; final response is still the last 302.
    expect(sender).toHaveBeenCalledTimes(6)
    expect(res.redirects()).toHaveLength(5)
    expect(res.status()).toBe(302)
  })

  it('redirects(0) disables following', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 302, headers: { location: '/dest' } }))
    const res = await new RequestBuilder(sender, 'GET', '/start').redirects(0)
    expect(sender).toHaveBeenCalledOnce()
    expect(res.status()).toBe(302)
  })

  it('generated status-shortcut asserts run lazily against the response', async () => {
    await new RequestBuilder(
      vi.fn(async () => makeResponse({ status: 410 })),
      'GET',
      '/p',
    ).assertGone()
    await expect(
      new RequestBuilder(
        vi.fn(async () => makeResponse({ status: 200 })),
        'GET',
        '/p',
      ).assertTooManyRequests(),
    ).rejects.toThrow(/Expected status 429/)
  })

  it('TLS knobs are inert no-ops that keep the chain (loopback has no TLS)', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    expect(builder.trustLocalhost().disableTLSCerts().ca('x').cert('y').privateKey('z')).toBe(
      builder,
    )
    await builder.send()
    expect(sender).toHaveBeenCalledOnce()
  })

  it('macro/getter graft onto every request builder', async () => {
    RequestBuilder.macro('tag', 'v1')
    RequestBuilder.getter('lazyTag', () => 'computed')
    const builder = new RequestBuilder(
      vi.fn(async () => makeResponse()),
      'GET',
      '/p',
    ) as RequestBuilder & { tag: string; lazyTag: string }
    expect(builder.tag).toBe('v1')
    expect(builder.lazyTag).toBe('computed')
  })

  it('awaiting the builder resolves to a rich ApiResponse', async () => {
    const res = await new RequestBuilder(
      vi.fn(async () =>
        makeResponse({ status: 200, headers: { 'x-a': '1' }, body: '{"ok":true}' }),
      ),
      'GET',
      '/p',
    )
    expect(res.header('x-a')).toBe('1')
    expect(res.statusType()).toBe(2)
    res.assertOk().assertBodyContains({ ok: true })
  })
})

describe('helix > RequestBuilder audit #3 parity', () => {
  it('header() accepts a string[] (joined)', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'GET', '/p').header('accept', ['a/b', 'c/d']).send()
    expect(sender.mock.calls[0][2].headers.accept).toBe('a/b, c/d')
  })

  it('form() repeats array values (a=1&a=2)', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/p').form({ tag: ['x', 'y'], n: 1 }).send()
    expect(sender.mock.calls[0][2].body.toString('utf8')).toBe('tag=x&tag=y&n=1')
  })

  it('field() accepts an array + a number (multiple parts)', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/p').field('t', ['a', 'b']).field('n', 42).send()
    const body = sender.mock.calls[0][2].body.toString('utf8')
    expect(body.match(/name="t"/g)).toHaveLength(2)
    expect(body).toContain('\r\n\r\n42\r\n')
  })

  it('file() drains a Readable stream to the multipart part', async () => {
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/up')
      .file('doc', Readable.from(['strea', 'med']), {
        filename: 'd.txt',
        contentType: 'text/plain',
      })
      .send()
    const body = sender.mock.calls[0][2].body.toString('utf8')
    expect(body).toContain('filename="d.txt"')
    expect(body).toContain('\r\n\r\nstreamed\r\n')
  })

  it('addSerializer + serialize() sets a custom body', async () => {
    RequestBuilder.addSerializer('csv', (data) => ({
      body: Buffer.from((data as string[]).join(','), 'utf8'),
      contentType: 'text/csv',
    }))
    const sender = vi.fn(async () => makeResponse())
    await new RequestBuilder(sender, 'POST', '/p').serialize('csv', ['a', 'b', 'c']).send()
    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toBe('text/csv')
    expect(init.body.toString('utf8')).toBe('a,b,c')
  })
})

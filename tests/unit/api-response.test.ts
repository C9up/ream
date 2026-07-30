/**
 * `ApiResponse` — the rich `@japa/api-client` response parity: METHOD accessors
 * (`status()`/`headers()`/`body()`/`text()`/…), the immediate `assert*` surface,
 * `dump*`, and `macro`/`getter`.
 */

import { describe, expect, it } from 'vitest'
import { ApiResponse, type TestResponse } from '../../src/testing/RequestBuilder.js'

const raw = (over: Partial<TestResponse> = {}): TestResponse => {
  const body = over.body ?? ''
  return {
    status: over.status ?? 200,
    headers: over.headers ?? {},
    body,
    json<T = unknown>(): T {
      return JSON.parse(body) as T
    },
  }
}

describe('ream > ApiResponse accessors (Japa method form)', () => {
  it('exposes status()/headers()/text()/body()/json()/method()', () => {
    const res = new ApiResponse(
      raw({
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-trace': 'abc' },
        body: '{"id":7}',
      }),
      { method: 'POST' },
    )
    expect(res.status()).toBe(201)
    expect(res.statusType()).toBe(2)
    expect(res.header('x-trace')).toBe('abc')
    expect(res.headers()['x-trace']).toBe('abc')
    expect(res.text()).toBe('{"id":7}')
    expect(res.body()).toEqual({ id: 7 }) // content-type json → parsed
    expect(res.json<{ id: number }>().id).toBe(7)
    expect(res.method()).toBe('POST')
    expect(res.type()).toBe('application/json')
    expect(res.charset()).toBe('utf-8')
    expect(res.hasBody()).toBe(true)
    expect(res.hasError()).toBe(false)
  })

  it('body() parses application/x-www-form-urlencoded', () => {
    const res = new ApiResponse(
      raw({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two' }),
    )
    expect(res.body()).toEqual({ a: '1', b: 'two' })
  })

  it('body() returns raw text for other content types', () => {
    const res = new ApiResponse(
      raw({ headers: { 'content-type': 'text/html' }, body: '<h1>hi</h1>' }),
    )
    expect(res.body()).toBe('<h1>hi</h1>')
  })

  it('parses cookies + Link header + error() object', () => {
    const res = new ApiResponse(
      raw({
        status: 503,
        headers: {
          'set-cookie': 'session=abc; Path=/; HttpOnly, theme=dark; Path=/',
          link: '</next>; rel="next", </prev>; rel="prev"',
        },
        body: 'boom',
      }),
    )
    expect(res.cookie('session')?.value).toBe('abc')
    expect(res.cookie('session')?.path).toBe('/')
    expect(res.cookies().theme.value).toBe('dark')
    expect(res.links().next).toBe('/next')
    expect(res.hasError()).toBe(true)
    expect(res.hasFatalError()).toBe(true)
    // Japa error() is an object with status + text, not a string.
    expect(res.error()).toEqual({ status: 503, text: 'boom' })
  })

  it('error() is undefined for a 2xx response', () => {
    expect(new ApiResponse(raw({ status: 200 })).error()).toBeUndefined()
  })

  it('tracks the redirect chain passed by the builder', () => {
    const res = new ApiResponse(raw({ status: 200 }), { redirects: ['/a', '/b'] })
    expect(res.redirects()).toEqual(['/a', '/b'])
  })

  it('dump* methods return this (smoke)', () => {
    const res = new ApiResponse(raw({ status: 200, body: '{}' }))
    expect(res.dumpBody().dumpHeaders().dumpCookies()).toBe(res)
  })
})

describe('ream > ApiResponse assertions', () => {
  it('status shortcuts pass on the matching code and throw otherwise', () => {
    expect(() => new ApiResponse(raw({ status: 200 })).assertOk()).not.toThrow()
    expect(() => new ApiResponse(raw({ status: 409 })).assertConflict()).not.toThrow()
    expect(() => new ApiResponse(raw({ status: 410 })).assertGone()).not.toThrow()
    expect(() => new ApiResponse(raw({ status: 418 })).assertImATeapot()).not.toThrow()
    expect(() => new ApiResponse(raw({ status: 422 })).assertUnprocessableEntity()).not.toThrow()
    expect(() => new ApiResponse(raw({ status: 200 })).assertCreated()).toThrow(
      /Expected status 201/,
    )
  })

  it('chains immediate assertions returning this', () => {
    const res = new ApiResponse(
      raw({ status: 200, headers: { 'x-a': '1' }, body: '{"id":1,"name":"Ada"}' }),
    )
    expect(res.assertOk().assertHeader('x-a', '1').assertBodyContains({ id: 1 })).toBe(res)
  })

  it('assertRedirectsTo checks the followed chain and a direct 3xx Location', () => {
    // Direct 3xx match (no follow).
    const direct = new ApiResponse(raw({ status: 302, headers: { location: '/login?next=/x' } }))
    expect(() => direct.assertRedirectsTo('/login')).not.toThrow()
    expect(() => direct.assertRedirectsTo('/nope')).toThrow(/Expected redirect to "\/nope"/)
    // Followed chain ending in 200 (Japa: assertion still holds).
    const followed = new ApiResponse(raw({ status: 200 }), { redirects: ['/login'] })
    expect(() => followed.assertRedirectsTo('/login')).not.toThrow()
  })

  it('assertCookie / assertCookieMissing read Set-Cookie', () => {
    const res = new ApiResponse(raw({ headers: { 'set-cookie': 'session=abc; Path=/' } }))
    expect(() => res.assertCookie('session', 'abc')).not.toThrow()
    expect(() => res.assertCookie('session', 'zzz')).toThrow(/Expected cookie session/)
    expect(() => res.assertCookieMissing('theme')).not.toThrow()
    expect(() => res.assertCookieMissing('session')).toThrow(/to be absent/)
  })
})

describe('ream > ApiResponse audit #3 parity', () => {
  it('assertBody parses application/x-www-form-urlencoded (not just JSON)', () => {
    const res = new ApiResponse(
      raw({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two' }),
    )
    expect(() => res.assertBody({ a: '1', b: 'two' })).not.toThrow()
    expect(() => res.assertBodyContains({ a: '1' })).not.toThrow()
    expect(() => res.assertBody({ a: '9' })).toThrow(/Expected body to equal/)
  })

  it('files() parses a multipart/form-data response', () => {
    const boundary = 'XyZ'
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="note"\r\n\r\nhello\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="doc"; filename="a.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nFILE-BYTES\r\n` +
      `--${boundary}--\r\n`
    const res = new ApiResponse(
      raw({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body }),
    )
    const files = res.files()
    expect(files.doc.filename).toBe('a.txt')
    expect(files.doc.type).toBe('text/plain')
    expect(files.doc.content.toString('utf8')).toBe('FILE-BYTES')
    // Non-file fields land in body().
    expect(res.body()).toEqual({ note: 'hello' })
  })

  it('assertAgainstApiSpec throws until a validator is registered, then delegates', () => {
    const res = new ApiResponse(raw({ status: 200 }))
    expect(() => res.assertAgainstApiSpec()).toThrow(/requires an OpenAPI validator/)
    let seen: ApiResponse | undefined
    ApiResponse.registerApiSpecValidator((r) => {
      seen = r
    })
    expect(() => res.assertAgainstApiSpec()).not.toThrow()
    expect(seen).toBe(res)
  })

  it('addParser feeds body() for a custom content-type', () => {
    ApiResponse.addParser('application/x-ndjson', (text) => text.trim().split('\n'))
    const res = new ApiResponse(
      raw({ headers: { 'content-type': 'application/x-ndjson' }, body: 'a\nb\n' }),
    )
    expect(res.body()).toEqual(['a', 'b'])
  })
})

describe('ream > ApiResponse.macro/getter', () => {
  it('getter receives `this` bound to the response (Japa form)', () => {
    ApiResponse.getter('ct', function () {
      return this.header('content-type')
    })
    const res = new ApiResponse(
      raw({ headers: { 'content-type': 'application/json' } }),
    ) as ApiResponse & { ct: string }
    expect(res.ct).toBe('application/json')
  })

  it('grafts a macro value and a lazy getter onto every response', () => {
    ApiResponse.macro('answer', 42)
    let calls = 0
    ApiResponse.getter('lazy', () => {
      calls += 1
      return 'computed'
    })
    const res = new ApiResponse(raw({ status: 200 })) as ApiResponse & {
      answer: number
      lazy: string
    }
    expect(res.answer).toBe(42)
    expect(res.lazy).toBe('computed')
    expect(res.lazy).toBe('computed')
    expect(calls).toBe(1) // cached per response
  })
})

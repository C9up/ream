import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'

describe('security regressions > request/cookie parsing', () => {
  it('Request.qs does not throw on malformed percent-encoding', () => {
    const req = new Request(
      {
        method: 'GET',
        path: '/search',
        query: 'q=%E0%A4%A&ok=1',
        headers: {},
        body: '',
      },
      {},
    )

    expect(() => req.qs()).not.toThrow()
    expect(req.qs().ok).toBe('1')
  })

  it('Request.cookie reads from the pre-parsed cookies map', () => {
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      headers: {},
      body: '',
      cookies: { session: 'abc', token: 'xyz' },
    })
    expect(req.cookie('session')).toBe('abc')
    expect(req.cookie('missing')).toBeNull()
    expect(req.cookies()).toEqual({ session: 'abc', token: 'xyz' })
  })

  it('Request.cookie falls back to header parsing for legacy fixtures', () => {
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      headers: { cookie: 'a=1; b=2' },
      body: '',
    })
    expect(req.cookie('a')).toBe('1')
    expect(req.cookie('b')).toBe('2')
  })

  it('Request.cookies() fallback preserves cookies with empty values (RFC 6265)', () => {
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      // `session=` is valid RFC 6265 — used in logout flows that explicitly
      // clear a cookie's value. Must not be silently dropped.
      headers: { cookie: 'session=; flag=on; trace=' },
      body: '',
    })
    expect(req.cookies()).toEqual({ session: '', flag: 'on', trace: '' })
    expect(req.cookie('session')).toBe('')
    expect(req.cookie('trace')).toBe('')
  })
})

// === Audit fix tests ===

describe('security regressions > CRLF header injection', () => {
  it('Response.header rejects CRLF in value', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.header('x-custom', 'value\r\ninjected: true')).toThrow(/CRLF/)
  })

  it('Response.header accepts normal values', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.header('x-custom', 'normal value')).not.toThrow()
  })

  it('Response.type rejects CRLF/NUL (no response-splitting via content-type)', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.type('text/html\r\nset-cookie: evil=1')).toThrow(/CRLF/)
    expect(() => res.type('text/html\0')).toThrow(/CRLF/)
  })

  it('Response.type accepts a normal content-type', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.type('application/json')).not.toThrow()
    expect(res.getHeaders()['content-type']).toBe('application/json')
  })
})

describe('security regressions > Response.append Set-Cookie stays multi-line', () => {
  it('append("set-cookie", ...) keeps each cookie on its own line (not comma-joined)', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.append('set-cookie', 'a=1; Path=/')
    res.append('set-cookie', 'b=2; Path=/')
    const setCookie = res.getHeaders()['set-cookie']
    // The serializer splits on \n into separate Set-Cookie headers.
    expect(setCookie).toBe('a=1; Path=/\nb=2; Path=/')
    // Must NOT be the invalid comma-joined single header.
    expect(setCookie).not.toContain('a=1; Path=/, b=2')
  })

  it('append Set-Cookie interleaves with cookie() into the same channel', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.cookie('sid', 'abc', { path: '/' })
    res.append('set-cookie', 'flag=on; Path=/')
    const lines = (res.getHeaders()['set-cookie'] ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('sid=abc')
    expect(lines[1]).toBe('flag=on; Path=/')
  })

  it('append on a non-Set-Cookie header still comma-joins (unchanged)', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.append('accept', 'text/html')
    res.append('accept', 'application/json')
    expect(res.getHeaders().accept).toBe('text/html, application/json')
  })
})

describe('security regressions > cookie SameSite=None requires Secure', () => {
  it('Response.cookie throws when SameSite=None is paired with secure=false', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.cookie('sid', 'abc', { sameSite: 'none', secure: false })).toThrow(
      /SameSite=None requires Secure/,
    )
  })

  it('Response.cookie throws when SameSite=None is paired with secure omitted', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.cookie('sid', 'abc', { sameSite: 'none' })).toThrow(
      /SameSite=None requires Secure/,
    )
  })

  it('Response.cookie accepts SameSite=None when secure=true', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.cookie('sid', 'abc', { sameSite: 'none', secure: true })).not.toThrow()
  })

  it('Response.cookie still accepts SameSite=lax/strict without Secure', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    expect(() => res.cookie('a', 'b', { sameSite: 'lax' })).not.toThrow()
    expect(() => res.cookie('c', 'd', { sameSite: 'strict' })).not.toThrow()
  })
})

describe('security regressions > cookie maxAge=0 emits Max-Age=0 (RFC 6265 delete-now)', () => {
  it('Response.cookie maxAge=0 → Set-Cookie carries Max-Age=0', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.cookie('sid', '', { maxAge: 0, path: '/' })
    const setCookie = res.getHeaders()['set-cookie']
    expect(setCookie).toContain('Max-Age=0')
  })

  it('Response.cookie maxAge=-1 → Set-Cookie carries Max-Age=-1', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.cookie('sid', '', { maxAge: -1 })
    expect(res.getHeaders()['set-cookie']).toContain('Max-Age=-1')
  })

  it('Response.cookie maxAge omitted → no Max-Age attribute', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.cookie('sid', 'abc', { path: '/' })
    expect(res.getHeaders()['set-cookie']).not.toContain('Max-Age')
  })

  it('Response.cookie maxAge=3600 → Set-Cookie carries Max-Age=3600 (positive path)', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    res.cookie('sid', 'abc', { maxAge: 3600 })
    expect(res.getHeaders()['set-cookie']).toContain('Max-Age=3600')
  })
})

describe('security regressions > Container reserved tokens', () => {
  it('rejects __proto__ as token', async () => {
    const { Container } = await import('../../src/container/Container.js')
    const c = new Container()
    expect(() => c.singleton('__proto__', () => 'evil')).toThrow(/Reserved/)
  })

  it('rejects constructor as token', async () => {
    const { Container } = await import('../../src/container/Container.js')
    const c = new Container()
    expect(() => c.singleton('constructor', () => 'evil')).toThrow(/Reserved/)
  })
})

// CORS now lives in @c9up/blackhole (createBlackhole validates the
// origin=* + credentials misconfiguration); covered by blackhole's own tests.

describe('security regressions > trustedProxies CIDR', () => {
  // CIDR resolution moved to Rust (see crates/ream-http/src/ip.rs). The JS
  // `Request.ip()` accessor reads the pre-resolved value the HyperServer
  // wrote into `RawRequest.ip`. These cases assert the JS-side handoff: when
  // the server fills `ip`, JS uses it verbatim.

  it('uses the pre-resolved ip when the server set it', async () => {
    const { Request } = await import('../../src/http/Request.js')
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      body: '',
      headers: { 'x-forwarded-for': '203.0.113.5' },
      remoteAddr: '10.0.0.42',
      ip: '203.0.113.5', // server resolved through trusted-proxy chain
    })
    expect(req.ip()).toBe('203.0.113.5')
  })

  it('returns the server-resolved peer when the proxy was untrusted', async () => {
    const { Request } = await import('../../src/http/Request.js')
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      body: '',
      headers: { 'x-forwarded-for': '203.0.113.5' },
      remoteAddr: '192.168.1.1',
      ip: '192.168.1.1', // server saw an untrusted peer, fell back to remoteAddr
    })
    expect(req.ip()).toBe('192.168.1.1')
  })

  it('TS fallback (no #raw.ip) ignores x-forwarded-for / x-real-ip and uses remoteAddr', async () => {
    // Pre-fix: a hand-built RawRequest without `ip` consumed XFF directly,
    // bypassing the Rust trusted-proxy gate and giving tests a second
    // (spoofable) semantic for the same API. The fallback is now strict —
    // headers are NEVER trusted in TS-land; the only way to assert a
    // proxy-resolved IP is to set `ip:` on the fixture, mirroring what the
    // HyperServer ships at runtime.
    const { Request } = await import('../../src/http/Request.js')
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      body: '',
      headers: { 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '198.51.100.7' },
      remoteAddr: '10.0.0.42',
      // ip: undefined (no Rust pipeline) — must fall back to remoteAddr.
    })
    expect(req.ip()).toBe('10.0.0.42')
  })

  it('TS fallback falls all the way back to 127.0.0.1 when remoteAddr is also absent', async () => {
    const { Request } = await import('../../src/http/Request.js')
    const req = new Request({
      method: 'GET',
      path: '/',
      query: '',
      body: '',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    })
    expect(req.ip()).toBe('127.0.0.1')
  })
})

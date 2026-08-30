/**
 * The pieces of the AdonisJS `Request` / `Response` surface a migrating app
 * reaches for, and that ream did not have: content-negotiation singulars, the
 * `update*` family a rewriting middleware uses, `authority()`, `abortUnless()`,
 * and the cookie attributes — `domain` above all, without which a session
 * cannot be shared across subdomains.
 */

import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'
import { Response } from '../../src/http/Response.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'

function request(headers: Record<string, string> = {}, query = '', body = ''): Request {
  return new Request({ method: 'GET', path: '/', query, headers, body })
}

describe('Request > content negotiation singulars', () => {
  it('picks the best offered charset', () => {
    const r = request({ 'accept-charset': 'iso-8859-1;q=0.2, utf-8;q=0.9' })
    expect(r.charset(['iso-8859-1', 'utf-8'])).toBe('utf-8')
  })

  it('picks the best offered encoding', () => {
    const r = request({ 'accept-encoding': 'gzip;q=0.3, br;q=0.9' })
    expect(r.encoding(['gzip', 'br'])).toBe('br')
  })

  it('returns null when nothing offered matches', () => {
    expect(request({ 'accept-charset': 'utf-8' }).charset(['iso-8859-1'])).toBeNull()
  })

  it('falls back to the first offer when the client stated no preference', () => {
    expect(request().encoding(['br', 'gzip'])).toBe('br')
  })

  it('honours a wildcard', () => {
    expect(request({ 'accept-charset': '*' }).charset(['utf-8'])).toBe('utf-8')
  })
})

describe('Request > authority', () => {
  it('prefers the HTTP/2 pseudo-header over Host', () => {
    const r = request({ ':authority': 'h2.example.com', host: 'legacy.example.com' })
    expect(r.authority()).toBe('h2.example.com')
  })

  it('falls back to Host', () => {
    expect(request({ host: 'example.com:8080' }).authority()).toBe('example.com:8080')
  })

  it('ignores X-Forwarded-Host even under trust-proxy', () => {
    // No proxy convention forwards `:authority`, so trusting one here would let
    // a proxy rewrite the value a redirect check is validated against.
    const r = request({ host: 'real.example.com', 'x-forwarded-host': 'evil.example.com' })
    r.setTrustProxy(true)
    expect(r.authority()).toBe('real.example.com')
    // host() still honours it — that IS a forwarded-host convention.
    expect(r.host()).toBe('evil.example.com')
  })

  it('is null when neither header is present', () => {
    expect(request().authority()).toBeNull()
  })
})

describe('Request > update family', () => {
  it('replaces the body and recomputes all()', () => {
    const r = request({}, 'page=2', '{"name":"raw"}')
    r.setParsedBody({ name: 'raw' })
    expect(r.all()).toEqual({ page: '2', name: 'raw' })

    r.updateBody({ name: 'sanitized' })

    expect(r.all()).toEqual({ page: '2', name: 'sanitized' })
  })

  it('keeps original() pointing at what the user actually sent', () => {
    // Flash old-input must show the submitted value, not a middleware rewrite.
    const r = request({}, '', '')
    r.setParsedBody({ name: 'typed by the user' })
    r.all()

    r.updateBody({ name: 'rewritten' })

    expect(r.original()).toEqual({ name: 'typed by the user' })
  })

  it('replaces the query data and recomputes all()', () => {
    const r = request({}, 'page=2')
    r.setParsedBody({ name: 'x' })
    expect(r.all().page).toBe('2')

    r.updateQs({ page: '9' })

    expect(r.all()).toEqual({ page: '9', name: 'x' })
  })

  it('replaces the raw body', () => {
    const r = request({}, '', 'original')
    expect(r.raw()).toBe('original')

    r.updateRawBody('replaced')

    expect(r.raw()).toBe('replaced')
  })
})

describe('Response > abortUnless', () => {
  it('throws when the condition is falsy', () => {
    const res = new Response()
    expect(() => res.abortUnless(null, 'Not found', 404)).toThrow()
  })

  it('passes a truthy condition through', () => {
    const res = new Response()
    expect(() => res.abortUnless('ok', 'Not found', 404)).not.toThrow()
  })
})

describe('Response > stream drains without being awaited', () => {
  it('sends the whole body when the caller ignores the promise', async () => {
    // Upstream's stream() returns void, so a migrated controller never awaits.
    const res = new Response()
    res.stream(Readable.from([Buffer.from('hello '), Buffer.from('world')]))

    await res.finish()

    expect(Buffer.from(res.getBody(), 'base64').toString()).toBe('hello world')
  })

  it('maps a read failure through errorCallback', async () => {
    const res = new Response()
    const failing = new Readable({
      read() {
        this.destroy(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      },
    })

    res.stream(failing, (error) => (error.code === 'ENOENT' ? ['Not found', 404] : ['Boom', 500]))
    await res.finish()

    expect(res.getStatus()).toBe(404)
    expect(res.getBody()).toBe('Not found')
  })
})

describe('Response > cookie attributes', () => {
  function cookieHeader(name: string, value: string, options?: Parameters<Response['cookie']>[2]) {
    const res = new Response()
    // `cookie()` signs, so it needs a key — the attributes below are what is
    // under test, and they are written the same either way.
    res.setCookieSigner(new CookieSigner('a'.repeat(32)))
    res.cookie(name, value, options)
    return res.getHeaders()['set-cookie']
  }

  it('writes Domain, so a session can span subdomains', () => {
    expect(cookieHeader('sid', 'x', { domain: '.example.com' })).toContain('Domain=.example.com')
  })

  it('writes an absolute Expires, from a Date or a function', () => {
    const at = new Date('2030-01-01T00:00:00Z')
    expect(cookieHeader('a', '1', { expires: at })).toContain(`Expires=${at.toUTCString()}`)
    expect(cookieHeader('b', '1', { expires: () => at })).toContain(`Expires=${at.toUTCString()}`)
  })

  it('writes Partitioned and Priority', () => {
    const header = cookieHeader('c', '1', { secure: true, partitioned: true, priority: 'high' })
    expect(header).toContain('Partitioned')
    expect(header).toContain('Priority=high')
  })

  it('refuses Partitioned without Secure, which browsers would drop', () => {
    expect(() => cookieHeader('d', '1', { partitioned: true })).toThrow(/requires Secure/)
  })

  it('omits SameSite on the boolean false form', () => {
    expect(cookieHeader('e', '1', { sameSite: false })).not.toContain('SameSite')
  })

  it('refuses sameSite: true, which is not an attribute value', () => {
    expect(() => cookieHeader('f', '1', { sameSite: true })).toThrow(/not an attribute value/)
  })

  it('refuses a CRLF in Domain, as it does in Path', () => {
    expect(() => cookieHeader('g', '1', { domain: 'a\r\nSet-Cookie: evil=1' })).toThrow()
  })
})

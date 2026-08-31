/**
 * The AdonisJS Request members a migrated controller reads: the request id, the
 * full URL, content negotiation, and the referrer — which is attacker-supplied
 * and must be validated before anything redirects back to it.
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'

function request(headers: Record<string, string> = {}, query = ''): Request {
  return new Request(
    {
      method: 'GET',
      url: '/posts',
      path: '/posts',
      query,
      headers: { host: 'app.test', ...headers },
      body: '',
    } as never,
    {},
  )
}

describe('ream > request identity', () => {
  it('reports the id the proxy set, and nothing when it did not', () => {
    expect(request({ 'x-request-id': 'abc' }).id()).toBe('abc')
    // Not invented: a correlation id nobody else knows correlates nothing.
    expect(request().id()).toBeUndefined()
  })

  it('splits the URL', () => {
    expect(request({}, 'page=2').parsedUrl()).toEqual({
      pathname: '/posts',
      search: '?page=2',
      query: 'page=2',
    })
  })

  it('builds the complete URL, with or without the query', () => {
    const req = request({}, 'page=2')
    expect(req.completeUrl()).toBe('http://app.test/posts')
    expect(req.completeUrl(true)).toBe('http://app.test/posts?page=2')
  })

  it('recognises an XHR, a pjax and a speculative prefetch', () => {
    expect(request({ 'x-requested-with': 'XMLHttpRequest' }).ajax()).toBe(true)
    expect(request().ajax()).toBe(false)
    expect(request({ 'x-pjax': 'true' }).pjax()).toBe(true)
    expect(request({ 'sec-purpose': 'prefetch;prerender' }).prefetch()).toBe(true)
    expect(request({ purpose: 'prefetch' }).prefetch()).toBe(true)
    expect(request().prefetch()).toBe(false)
  })
})

describe('ream > previous URL', () => {
  it("returns the referrer's path when the host is our own", () => {
    expect(request({ referer: 'http://app.test/dashboard?tab=1' }).getPreviousUrl()).toBe(
      '/dashboard?tab=1',
    )
  })

  it('refuses a referrer from somewhere else', () => {
    // A referrer is attacker-controlled; redirecting back to it unchecked is
    // an open redirect.
    expect(request({ referer: 'https://evil.test/steal' }).getPreviousUrl()).toBe('/')
    expect(request({ referer: 'https://evil.test/steal' }).getPreviousUrl([], '/home')).toBe(
      '/home',
    )
  })

  it('accepts a host that was explicitly allowed', () => {
    expect(request({ referer: 'https://admin.test/x' }).getPreviousUrl(['admin.test'])).toBe('/x')
  })

  it('falls back on a missing or unparseable referrer', () => {
    expect(request().getPreviousUrl()).toBe('/')
    expect(request({ referer: 'not a url' }).getPreviousUrl()).toBe('/')
  })
})

describe('ream > content negotiation lists', () => {
  it("orders by the client's preference, not the header order", () => {
    const req = request({
      accept: 'text/html;q=0.1, application/json;q=0.9',
      'accept-language': 'en;q=0.2, fr;q=0.8',
      'accept-encoding': 'gzip, br;q=0.9',
      'accept-charset': 'utf-8, iso-8859-1;q=0.5',
    })
    expect(req.types()[0]).toBe('application/json')
    expect(req.languages()[0]).toBe('fr')
    // Equal q keeps the written order.
    expect(req.encodings()[0]).toBe('gzip')
    expect(req.charsets()[0]).toBe('utf-8')
  })

  it('returns nothing when the client stated nothing', () => {
    expect(request().languages()).toEqual([])
  })
})

describe('ream > serialization', () => {
  it('reports the whole request, as upstream does', () => {
    const req = request({ 'x-request-id': 'abc' }, 'page=2')

    const json = req.serialize()

    // A debugging dump: every field upstream carries, including the ones that
    // hold credentials. `serializeSafe()` is the one built for a log line.
    expect(json).toMatchObject({
      id: 'abc',
      method: 'GET',
      query: 'page=2',
      protocol: 'http',
      hostname: 'app.test',
    })
    for (const key of ['body', 'cookies', 'headers', 'params', 'ip', 'subdomains']) {
      expect(json, key).toHaveProperty(key)
    }
  })

  it('toJSON is the same view, under the name JSON.stringify reaches for', () => {
    const req = request({ 'x-request-id': 'abc' }, 'page=2')

    expect(JSON.parse(JSON.stringify(req.toJSON()))).toMatchObject({
      url: '/posts?page=2',
    })
    expect(req.toJSON()).toEqual(req.serialize())
  })
})

import { describe, expect, it } from 'vitest'
import { type RawRequest, Request } from '../../src/http/Request.js'

function req(raw: Partial<RawRequest>): Request {
  return new Request({ method: 'GET', path: '/', query: '', headers: {}, body: '', ...raw })
}

/**
 * `protocol()`, `secure()`, `host()` and `ips()` believe forwarded headers
 * only from a trusted proxy — the peer the Rust layer matched against
 * `server.trustedProxies()`. They used to hang on a per-request flag nothing
 * set (so `secure()` was always false behind a TLS-terminating proxy) and
 * that, once set, believed the headers from any client.
 */
describe('Request forwarded headers follow the trusted-proxy decision', () => {
  // What the Rust layer ships for a request that came through 10.0.0.2, a
  // trusted proxy, on behalf of 203.0.113.9: the peer is trusted and the
  // chain walked past it.
  const viaTrustedProxy = {
    remoteAddr: '10.0.0.2',
    ip: '203.0.113.9',
    ips: ['10.0.0.2', '203.0.113.9'],
    peerTrusted: true,
  }
  // A client hitting the app port directly: the chain stops at the peer.
  const direct = {
    remoteAddr: '198.51.100.7',
    ip: '198.51.100.7',
    ips: ['198.51.100.7'],
    peerTrusted: false,
  }
  // A trusted proxy that forwards the scheme and host but no X-Forwarded-For:
  // the chain is the peer alone, and the peer is still trusted.
  const trustedProxyWithoutForwardedFor = {
    remoteAddr: '10.0.0.2',
    ip: '10.0.0.2',
    ips: ['10.0.0.2'],
    peerTrusted: true,
  }

  it('honours X-Forwarded-Proto from a trusted proxy', () => {
    const r = req({ ...viaTrustedProxy, headers: { 'x-forwarded-proto': 'https' } })
    expect(r.protocol()).toBe('https')
    expect(r.secure()).toBe(true)
  })

  it('honours the forwarded scheme and host of a trusted proxy that sends no X-Forwarded-For', () => {
    const r = req({
      ...trustedProxyWithoutForwardedFor,
      headers: {
        host: 'internal:3000',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example.com',
      },
    })
    expect(r.protocol()).toBe('https')
    expect(r.host()).toBe('app.example.com')
    expect(r.ips()).toEqual(['10.0.0.2'])
  })

  it('does not take a chain longer than the peer as proof of trust', () => {
    const r = req({
      remoteAddr: '198.51.100.7',
      ip: '6.6.6.6',
      ips: ['198.51.100.7', '6.6.6.6'],
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(r.protocol()).toBe('http')
    expect(r.ips()).toEqual(['6.6.6.6'])
  })

  it('ignores X-Forwarded-Proto from an untrusted peer', () => {
    const r = req({ ...direct, headers: { 'x-forwarded-proto': 'https' } })
    expect(r.protocol()).toBe('http')
    expect(r.secure()).toBe(false)
  })

  it('ignores X-Forwarded-Proto on a hand-built request with no chain', () => {
    const r = req({ headers: { 'x-forwarded-proto': 'https' } })
    expect(r.protocol()).toBe('http')
  })

  it('takes the first X-Forwarded-Proto value, lowercased', () => {
    const r = req({ ...viaTrustedProxy, headers: { 'x-forwarded-proto': 'HTTPS, http' } })
    expect(r.protocol()).toBe('https')
  })

  it('falls back to the connection scheme when a trusted proxy sends no protocol', () => {
    expect(req({ ...viaTrustedProxy }).protocol()).toBe('http')
  })

  it('reports https for a TLS connection whatever the headers say', () => {
    expect(req({ scheme: 'https' }).protocol()).toBe('https')
    const r = req({ ...viaTrustedProxy, scheme: 'https', headers: { 'x-forwarded-proto': 'http' } })
    expect(r.protocol()).toBe('https')
  })

  it('honours X-Forwarded-Host from a trusted proxy only', () => {
    const headers = { host: 'internal:3000', 'x-forwarded-host': 'public.example.com, other' }
    expect(req({ ...viaTrustedProxy, headers }).host()).toBe('public.example.com')
    expect(req({ ...viaTrustedProxy, headers }).hostname()).toBe('public.example.com')
    expect(req({ ...direct, headers }).host()).toBe('internal:3000')
  })

  it('returns the trusted chain, closest hop first, ending with ip()', () => {
    const r = req({
      remoteAddr: '10.0.0.2',
      ip: '203.0.113.9',
      ips: ['10.0.0.2', '10.0.0.1', '203.0.113.9'],
      peerTrusted: true,
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.1' },
    })
    // 6.6.6.6 was written by the client itself: no trusted hop vouched for it.
    expect(r.ips()).toEqual(['10.0.0.2', '10.0.0.1', '203.0.113.9'])
    expect(r.ips().at(-1)).toBe(r.ip())
  })

  it('returns the peer alone for an untrusted peer, whatever X-Forwarded-For says', () => {
    const r = req({ ...direct, headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })
    expect(r.ips()).toEqual(['198.51.100.7'])
  })

  it('returns [ip] on a hand-built request with no chain', () => {
    const r = req({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '1.1.1.1' } })
    expect(r.ips()).toEqual(['203.0.113.9'])
  })

  it('hands out a copy of the chain', () => {
    const r = req({ ...viaTrustedProxy })
    r.ips().push('9.9.9.9')
    expect(r.ips()).toEqual(['10.0.0.2', '203.0.113.9'])
  })
})

describe('Request.fresh / stale / matchesRoute', () => {
  it('fresh() delegates to the wired response; stale() negates it', () => {
    const r = req({})
    expect(r.fresh()).toBe(false) // no response wired yet
    r.setResponse({ fresh: () => true })
    expect(r.fresh()).toBe(true)
    expect(r.stale()).toBe(false)
  })

  it('matchesRoute() compares name or pattern', () => {
    const r = req({})
    expect(r.matchesRoute('users.show')).toBe(false) // no route info
    r.setRouteInfo({ name: 'users.show', pattern: '/users/:id' })
    expect(r.matchesRoute('users.show')).toBe(true)
    expect(r.matchesRoute('/users/:id')).toBe(true)
    expect(r.matchesRoute('posts.index')).toBe(false)
  })

  it('matchesRoute() takes a list, as AdonisJS does', () => {
    const r = req({})
    r.setRouteInfo({ name: 'users.show', pattern: '/users/:id' })

    // "am I on any of these routes" is the usual question; a caller with
    // several identifiers had to write the .some() themselves.
    expect(r.matchesRoute(['posts.index', 'users.show'])).toBe(true)
    expect(r.matchesRoute(['posts.index', '/users/:id'])).toBe(true)
    expect(r.matchesRoute(['posts.index', 'comments.store'])).toBe(false)
    expect(r.matchesRoute([])).toBe(false)
  })
})

describe('Request.matchesRoute matches the controller reference', () => {
  it('matches a route by its ControllerName.method identity', () => {
    const r = req({})
    r.setRouteInfo({
      name: 'users.show',
      pattern: '/users/:id',
      reference: 'UsersController.show',
    })

    // The identity AdonisJS matches through route.handler.reference, and the
    // form our own router already accepts as a handler.
    expect(r.matchesRoute('UsersController.show')).toBe(true)
    expect(r.matchesRoute(['PostsController.index', 'UsersController.show'])).toBe(true)
    expect(r.matchesRoute('UsersController.destroy')).toBe(false)
  })

  it('an inline handler has no reference to match', () => {
    const r = req({})
    r.setRouteInfo({ pattern: '/inline' })

    expect(r.matchesRoute('/inline')).toBe(true)
    expect(r.matchesRoute('Something.method')).toBe(false)
  })
})

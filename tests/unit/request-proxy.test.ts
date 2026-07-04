import { describe, expect, it } from 'vitest'
import { type RawRequest, Request } from '../../src/http/Request.js'

function req(raw: Partial<RawRequest>): Request {
  return new Request({ method: 'GET', path: '/', query: '', headers: {}, body: '', ...raw })
}

describe('Request trust-proxy accessors (opt-in, secure by default)', () => {
  it('protocol/secure default to the connection scheme, ignoring forwarded headers', () => {
    const r = req({ headers: { 'x-forwarded-proto': 'https' } })
    // Trust off → forwarded header ignored (no spoofing).
    expect(r.protocol()).toBe('http')
    expect(r.secure()).toBe(false)
  })

  it('protocol honours X-Forwarded-Proto once trust-proxy is enabled', () => {
    const r = req({ headers: { 'x-forwarded-proto': 'https' } })
    r.setTrustProxy(true)
    expect(r.protocol()).toBe('https')
    expect(r.secure()).toBe(true)
  })

  it('protocol uses the Rust-reported scheme when present', () => {
    expect(req({ scheme: 'https' }).protocol()).toBe('https')
  })

  it('ips returns [ip] by default and the XFF chain under trust-proxy', () => {
    const r = req({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })
    expect(r.ips()).toEqual(['203.0.113.9'])
    r.setTrustProxy(true)
    expect(r.ips()).toEqual(['1.1.1.1', '2.2.2.2'])
  })

  it('host honours X-Forwarded-Host only under trust-proxy', () => {
    const r = req({ headers: { host: 'internal:3000', 'x-forwarded-host': 'public.example.com' } })
    expect(r.host()).toBe('internal:3000')
    r.setTrustProxy(true)
    expect(r.host()).toBe('public.example.com')
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
})

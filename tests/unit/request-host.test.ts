import { describe, expect, it } from 'vitest'
import { type RawRequest, Request } from '../../src/http/Request.js'

function req(raw: Partial<RawRequest>): Request {
  return new Request({ method: 'GET', path: '/', query: '', headers: {}, body: '', ...raw })
}

describe('Request.host / hostname (AdonisJS parity)', () => {
  it('returns the Host header with and without port', () => {
    const r = req({ headers: { host: 'api.example.com:3000' } })
    expect(r.host()).toBe('api.example.com:3000')
    expect(r.hostname()).toBe('api.example.com')
  })

  it('returns null when no Host header is present', () => {
    expect(req({}).host()).toBeNull()
    expect(req({}).hostname()).toBeNull()
  })

  it('keeps an IPv6 literal intact when stripping the port', () => {
    const r = req({ headers: { host: '[::1]:8080' } })
    expect(r.hostname()).toBe('[::1]')
  })
})

describe('Request.subdomains (AdonisJS parity)', () => {
  it('returns subdomains above the registrable domain', () => {
    expect(req({ headers: { host: 'admin.api.example.com' } }).subdomains()).toEqual([
      'api',
      'admin',
    ])
  })

  it('drops www only when it is the last (registrable-adjacent) subdomain', () => {
    // `www.example.com` → [] (www stripped). AdonisJS only strips a trailing
    // `www`, so `blog.www.example.com` keeps both, ordered outermost-last.
    expect(req({ headers: { host: 'www.example.com' } }).subdomains()).toEqual([])
    expect(req({ headers: { host: 'blog.www.example.com' } }).subdomains()).toEqual(['www', 'blog'])
  })

  it('is empty for a bare domain or an IP host', () => {
    expect(req({ headers: { host: 'example.com' } }).subdomains()).toEqual([])
    expect(req({ headers: { host: '127.0.0.1:3000' } }).subdomains()).toEqual([])
  })
})

describe('Request.method — _method spoofing (opt-in)', () => {
  it('does NOT spoof by default (secure)', () => {
    const r = req({
      method: 'POST',
      body: JSON.stringify({ _method: 'DELETE' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(r.method()).toBe('POST')
    expect(r.intended()).toBe('POST')
  })

  it('honours _method on POST once enabled', () => {
    const r = req({
      method: 'POST',
      body: JSON.stringify({ _method: 'delete' }),
      headers: { 'content-type': 'application/json' },
    })
    r.setMethodSpoofing(true)
    expect(r.method()).toBe('DELETE')
    // intended() always reports the real verb.
    expect(r.intended()).toBe('POST')
  })

  it('never spoofs a non-POST request even when enabled', () => {
    const r = req({ method: 'GET', query: '_method=DELETE' })
    r.setMethodSpoofing(true)
    expect(r.method()).toBe('GET')
  })
})

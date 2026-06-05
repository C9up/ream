import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'

function req(headers: Record<string, string>): Request {
  return new Request({
    method: 'GET',
    path: '/',
    query: '',
    headers,
    body: '',
  })
}

describe('Request.accepts — RFC 7231 q-value content negotiation', () => {
  it('honours the client`s explicit q-value preference over the server`s offer order', () => {
    // Server offers HTML first, but the client clearly prefers JSON.
    const r = req({ accept: 'text/html;q=0.1, application/json;q=0.9' })
    expect(r.accepts(['html', 'json'])).toBe('json')
  })

  it('falls back to the server`s offer order when q-values tie', () => {
    const r = req({ accept: 'text/html, application/json' })
    expect(r.accepts(['json', 'html'])).toBe('json')
    expect(r.accepts(['html', 'json'])).toBe('html')
  })

  it('drops entries with q=0 (RFC 7231 — "not acceptable")', () => {
    const r = req({ accept: 'text/html;q=0, application/json' })
    expect(r.accepts(['html', 'json'])).toBe('json')
    expect(r.accepts(['html'])).toBeNull()
  })

  it('returns null when no offered type is accepted by the client', () => {
    const r = req({ accept: 'text/plain' })
    expect(r.accepts(['html', 'json'])).toBeNull()
  })

  it('expands short aliases (json/html/xml)', () => {
    expect(req({ accept: 'application/json' }).accepts(['json'])).toBe('json')
    expect(req({ accept: 'text/html' }).accepts(['html'])).toBe('html')
    expect(req({ accept: 'application/xml' }).accepts(['xml'])).toBe('xml')
  })

  it('honours type/* wildcards', () => {
    expect(req({ accept: 'text/*' }).accepts(['html', 'json'])).toBe('html')
    expect(req({ accept: 'application/*' }).accepts(['html', 'json'])).toBe('json')
  })

  it('returns the first offer for */* / */* with no q', () => {
    expect(req({ accept: '*/*' }).accepts(['html', 'json'])).toBe('html')
    expect(req({ accept: '*' }).accepts(['html', 'json'])).toBe('html')
  })

  it('falls back to */* when Accept is absent', () => {
    expect(req({}).accepts(['html', 'json'])).toBe('html')
  })
})

describe('Request.language — Accept-Language q-value negotiation', () => {
  it('honours q-values over the server`s offer order', () => {
    // Server lists `en` first but the client prefers `fr`.
    const r = req({ 'accept-language': 'en;q=0.1, fr;q=0.9' })
    expect(r.language(['en', 'fr'])).toBe('fr')
  })

  it('matches a primary subtag against a regional tag (en matches en-US)', () => {
    const r = req({ 'accept-language': 'en-US,en;q=0.9' })
    expect(r.language(['en'])).toBe('en')
    expect(r.language(['fr', 'en'])).toBe('en')
  })

  it('returns null when no offered language matches and the header is set', () => {
    const r = req({ 'accept-language': 'fr,de;q=0.7' })
    expect(r.language(['ja', 'ko'])).toBeNull()
  })

  it('falls back to the first offered language when the header is absent', () => {
    expect(req({}).language(['en', 'fr'])).toBe('en')
    expect(req({ 'accept-language': '' }).language(['en', 'fr'])).toBe('en')
  })

  it('drops q=0 entries', () => {
    const r = req({ 'accept-language': 'fr;q=0, en' })
    expect(r.language(['fr', 'en'])).toBe('en')
  })
})

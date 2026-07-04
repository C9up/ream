import { describe, expect, it } from 'vitest'
import { type RawRequest, Request } from '../../src/http/Request.js'

function req(raw: Partial<RawRequest>): Request {
  return new Request({
    method: 'POST',
    path: '/',
    query: '',
    headers: {},
    body: '',
    ...raw,
  })
}

function withBody(body: unknown, headers: Record<string, string> = {}): Request {
  return req({
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('Request.input — dot-notation (AdonisJS parity)', () => {
  it('reads a nested body value with dot-notation', () => {
    const r = withBody({ user: { address: { city: 'Geneva' } } })
    expect(r.input('user.address.city')).toBe('Geneva')
  })

  it('returns the default for an absent nested path', () => {
    const r = withBody({ user: { name: 'x' } })
    expect(r.input('user.address.city', 'unknown')).toBe('unknown')
  })

  it('still reads a flat top-level key', () => {
    const r = withBody({ email: 'a@b.ch' })
    expect(r.input('email')).toBe('a@b.ch')
  })

  it('merges query string with body (body wins)', () => {
    const r = req({
      query: 'page=2&q=x',
      body: JSON.stringify({ q: 'body' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(r.input('page')).toBe('2')
    expect(r.input('q')).toBe('body')
  })
})

describe('Request.only / except — nested (AdonisJS parity)', () => {
  it('only() picks nested branches', () => {
    const r = withBody({ user: { id: 1, name: 'x', secret: 's' } })
    expect(r.only(['user.id', 'user.name'])).toEqual({ user: { id: 1, name: 'x' } })
  })

  it('except() removes nested branches without touching the rest', () => {
    const r = withBody({ user: { id: 1, secret: 's' }, keep: true })
    expect(r.except(['user.secret'])).toEqual({ user: { id: 1 }, keep: true })
  })

  it('only() skips absent paths', () => {
    const r = withBody({ a: 1 })
    expect(r.only(['a', 'b.c'])).toEqual({ a: 1 })
  })
})

describe('Request.hasBody (AdonisJS parity)', () => {
  it('is true with a positive content-length', () => {
    expect(req({ headers: { 'content-length': '12' } }).hasBody()).toBe(true)
  })

  it('is true with a transfer-encoding header', () => {
    expect(req({ headers: { 'transfer-encoding': 'chunked' } }).hasBody()).toBe(true)
  })

  it('is false with no length and no transfer-encoding', () => {
    expect(req({ headers: {} }).hasBody()).toBe(false)
    expect(req({ headers: { 'content-length': '0' } }).hasBody()).toBe(false)
  })
})

describe('Request.header / cookie defaults (AdonisJS parity)', () => {
  it('header() returns the default when absent', () => {
    const r = req({ headers: { 'x-present': 'yes' } })
    expect(r.header('x-present', 'fallback')).toBe('yes')
    expect(r.header('x-absent', 'fallback')).toBe('fallback')
    expect(r.header('x-absent')).toBeUndefined()
  })

  it('plainCookie() returns the default when absent', () => {
    const r = req({ cookies: { session: 'abc' } })
    expect(r.plainCookie('session', 'def')).toBe('abc')
    expect(r.plainCookie('missing', 'def')).toBe('def')
    expect(r.plainCookie('missing')).toBeNull()
  })
})

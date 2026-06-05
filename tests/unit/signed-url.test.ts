import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignedUrl } from '../../src/security/SignedUrl.js'

const SECRET = 'a'.repeat(32)

describe('ream > SignedUrl > make + verify round-trip', () => {
  it('signs an URL and verifies its own signature', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/profile')
    expect(signed).toContain('signature=')
    expect(su.verify(signed)).toBe(true)
  })

  it('rejects an URL with no signature', () => {
    const su = new SignedUrl({ secret: SECRET })
    expect(su.verify('/profile')).toBe(false)
  })

  it('rejects an URL whose signature was tampered with', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/profile')
    const tampered = signed.replace(/signature=[^&]+/, 'signature=deadbeef')
    expect(su.verify(tampered)).toBe(false)
  })

  it('rejects when verified with a different secret', () => {
    const a = new SignedUrl({ secret: SECRET })
    const b = new SignedUrl({ secret: 'b'.repeat(32) })
    expect(b.verify(a.make('/profile'))).toBe(false)
  })
})

describe('ream > SignedUrl > expiration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('encodes an `expires` param relative to Date.now()', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { expiresIn: '1h' })
    const url = new URL(signed, 'http://x')
    const expires = parseInt(url.searchParams.get('expires') ?? '0', 10)
    expect(expires).toBe(Math.floor(Date.now() / 1000) + 3600)
  })

  it('verifies an unexpired URL', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { expiresIn: '1h' })
    expect(su.verify(signed)).toBe(true)
  })

  it('rejects after expiration', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { expiresIn: '1m' })
    vi.setSystemTime(new Date('2026-01-01T01:00:00Z')) // +1h
    expect(su.verify(signed)).toBe(false)
  })

  it('accepts a numeric expiresIn (seconds)', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { expiresIn: 30 })
    expect(su.verify(signed)).toBe(true)
  })

  it('honours expiresIn: 0 — URL stamps current time and is rejected once the clock moves (audit 2026-05-22)', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { expiresIn: 0 })
    // The URL must carry an `expires` param — previously the truthy check
    // dropped 0 and emitted a never-expiring URL.
    const url = new URL(signed, 'http://x')
    expect(url.searchParams.get('expires')).toBe(String(Math.floor(Date.now() / 1000)))
    // Same second — boundary, still accepted (verify uses strict >).
    expect(su.verify(signed)).toBe(true)
    // Advance 1 second: now expired.
    vi.setSystemTime(new Date(Date.now() + 1500))
    expect(su.verify(signed)).toBe(false)
  })

  it('parses every supported expiry suffix (s/m/h/d)', () => {
    const su = new SignedUrl({ secret: SECRET })
    const cases: Array<[string, number]> = [
      ['10s', 10],
      ['2m', 120],
      ['3h', 10800],
      ['1d', 86400],
    ]
    for (const [exp, secs] of cases) {
      const signed = su.make('/p', { expiresIn: exp })
      const url = new URL(signed, 'http://x')
      const expires = parseInt(url.searchParams.get('expires') ?? '0', 10)
      expect(expires).toBe(Math.floor(Date.now() / 1000) + secs)
    }
  })

  it('falls back to 1h when expiresIn string is malformed', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { expiresIn: 'garbage' })
    const url = new URL(signed, 'http://x')
    const expires = parseInt(url.searchParams.get('expires') ?? '0', 10)
    expect(expires).toBe(Math.floor(Date.now() / 1000) + 3600)
  })
})

describe('ream > SignedUrl > purpose binding', () => {
  it('verifies only when the purpose matches', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/reset', { purpose: 'password-reset' })
    expect(su.verify(signed, 'password-reset')).toBe(true)
    expect(su.verify(signed, 'email-verify')).toBe(false)
  })

  it('passes when no purpose is required, regardless of the embedded one', () => {
    const su = new SignedUrl({ secret: SECRET })
    const signed = su.make('/p', { purpose: 'x' })
    expect(su.verify(signed)).toBe(true)
  })
})

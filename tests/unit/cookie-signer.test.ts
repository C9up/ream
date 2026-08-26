/**
 * CookieSigner — HMAC sign/unsign and AES-256-GCM encrypt/decrypt. This backs
 * signed/encrypted cookies, so every tamper path must fail closed (null), and
 * round-trips must survive values that themselves contain the `.` separator.
 */
import { describe, expect, it } from 'vitest'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import { hmacSign } from '../../src/security/crypto.js'

const signer = new CookieSigner('super-secret-key')

describe('CookieSigner > sign / unsign', () => {
  it('round-trips a signed value', () => {
    const signed = signer.sign('session=abc')
    expect(signed).toMatch(/\./)
    expect(signer.unsign(signed)).toBe('session=abc')
  })

  it('preserves values that contain dots (split on the LAST dot)', () => {
    const signed = signer.sign('a.b.c')
    expect(signer.unsign(signed)).toBe('a.b.c')
  })

  it('returns null for a tampered value', () => {
    const signed = signer.sign('uid=1')
    // The payload is a base64url envelope, so flip a byte inside it rather
    // than searching for the plaintext.
    const dot = signed.lastIndexOf('.')
    const payload = signed.slice(0, dot)
    const flipped = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`
    expect(signer.unsign(`${flipped}${signed.slice(dot)}`)).toBeNull()
  })

  it('returns null for a tampered signature', () => {
    const signed = signer.sign('uid=1')
    expect(signer.unsign(`${signed}x`)).toBeNull()
  })

  it('returns null when there is no separator', () => {
    expect(signer.unsign('no-dot-here')).toBeNull()
  })

  it('returns null when verified with a different secret', () => {
    const signed = signer.sign('uid=1')
    expect(new CookieSigner('a-completely-different-secret').unsign(signed)).toBeNull()
  })
})

describe('CookieSigner > encrypt / decrypt', () => {
  it('round-trips an encrypted value', () => {
    const enc = signer.encrypt('top-secret')
    expect(enc.split('.')).toHaveLength(3) // iv.data.tag
    expect(signer.decrypt(enc)).toBe('top-secret')
  })

  it('produces a fresh ciphertext each time (random IV)', () => {
    expect(signer.encrypt('x')).not.toBe(signer.encrypt('x'))
  })

  it('returns null for a malformed payload (wrong part count)', () => {
    expect(signer.decrypt('only.two')).toBeNull()
  })

  it('returns null when the auth tag / ciphertext is tampered (GCM fails)', () => {
    const [iv, data, tag] = signer.encrypt('top-secret').split('.')
    expect(signer.decrypt(`${iv}.${data}AA.${tag}`)).toBeNull()
    expect(signer.decrypt(`${iv}.${data}.${tag.slice(0, -2)}AA`)).toBeNull()
  })

  it('returns null when decrypted with a different secret', () => {
    const enc = signer.encrypt('top-secret')
    expect(new CookieSigner('a-completely-different-secret').decrypt(enc)).toBeNull()
  })
})

describe('CookieSigner > purpose and expiry (AdonisJS parity)', () => {
  it('refuses a value presented for a different purpose', () => {
    const token = signer.encrypt('user-42', undefined, 'password-reset')
    expect(signer.decrypt(token, 'password-reset')).toBe('user-42')
    // The whole point: a reset token replayed as a session cookie fails here
    // rather than being honoured.
    expect(signer.decrypt(token, 'session')).toBeNull()
    expect(signer.decrypt(token)).toBeNull()
  })

  it('refuses an expired value', () => {
    const expired = signer.encrypt('x', -1)
    expect(signer.decrypt(expired)).toBeNull()
    const alive = signer.encrypt('x', 60_000)
    expect(signer.decrypt(alive)).toBe('x')
  })

  it('applies both to signed values too', () => {
    const signed = signer.sign('uid=1', 60_000, 'remember-me')
    expect(signer.unsign(signed, 'remember-me')).toBe('uid=1')
    expect(signer.unsign(signed, 'other')).toBeNull()
    expect(signer.unsign(signer.sign('uid=1', -1))).toBeNull()
  })

  it('refuses a missing or trivially short APP_KEY', () => {
    expect(() => new CookieSigner('')).toThrow(/Missing APP_KEY/)
    expect(() => new CookieSigner('short')).toThrow(/at least 16 characters/)
  })
})

describe('CookieSigner refuses what it did not seal', () => {
  const secret = 'a-sufficiently-long-app-key-for-tests'

  it('refuses a correctly-signed value that is not an envelope', () => {
    // Forged the way an older format would have looked: a valid signature over
    // a bare payload. The signature checks out, so the only thing standing
    // between it and the caller is the envelope check.
    const signer = new CookieSigner(secret)
    const bare = Buffer.from('plain-old-value').toString('base64url')
    const forged = `${bare}.${hmacSign(bare, secret)}`

    // It used to be handed back verbatim, which skipped the purpose check
    // below and let a value sealed for nothing pass as one sealed for a
    // specific use.
    expect(signer.unsign(forged)).toBe(null)
    expect(signer.unsign(forged, 'password-reset')).toBe(null)
  })

  it('refuses a signed JSON value with no message field', () => {
    const signer = new CookieSigner(secret)
    const payload = Buffer.from(JSON.stringify({ p: 'password-reset' })).toString('base64url')
    const forged = `${payload}.${hmacSign(payload, secret)}`

    expect(signer.unsign(forged, 'password-reset')).toBe(null)
  })

  it('still round-trips what it did seal, purpose included', () => {
    const signer = new CookieSigner(secret)
    const signed = signer.sign('value', undefined, 'password-reset')

    expect(signer.unsign(signed, 'password-reset')).toBe('value')
    expect(signer.unsign(signed)).toBe(null)
    expect(signer.unsign(signed, 'other')).toBe(null)
  })

  it('round-trips an encrypted value and refuses the wrong purpose', () => {
    const signer = new CookieSigner(secret)
    const sealed = signer.encrypt('secret-value', undefined, 'session')

    expect(signer.decrypt(sealed, 'session')).toBe('secret-value')
    expect(signer.decrypt(sealed)).toBe(null)
    expect(signer.decrypt(sealed, 'other')).toBe(null)
  })
})

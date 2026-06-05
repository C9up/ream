/**
 * CookieSigner — HMAC sign/unsign and AES-256-GCM encrypt/decrypt. This backs
 * signed/encrypted cookies, so every tamper path must fail closed (null), and
 * round-trips must survive values that themselves contain the `.` separator.
 */
import { describe, expect, it } from 'vitest'
import { CookieSigner } from '../../src/security/CookieSigner.js'

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
    const tampered = signed.replace('uid=1', 'uid=2')
    expect(signer.unsign(tampered)).toBeNull()
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
    expect(new CookieSigner('other-secret').unsign(signed)).toBeNull()
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
    expect(new CookieSigner('other-secret').decrypt(enc)).toBeNull()
  })
})

/**
 * Crypto facade — the Node fallback (HMAC sign/verify, random, constant-time)
 * plus the NAPI preinstall path + shape validation. This is what backs cookie
 * and session signing, so the verify/length-mismatch branches matter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  constantTimeEq,
  hasNativeCrypto,
  hmacSign,
  hmacVerify,
  randomBytesBase64,
  randomHex,
} from '../../src/security/crypto.js'

describe('security/crypto > Node fallback', () => {
  it('hmacSign is deterministic and hmacVerify round-trips', () => {
    const sig = hmacSign('payload', 'secret')
    expect(sig).toBe(hmacSign('payload', 'secret'))
    expect(hmacVerify('payload', sig, 'secret')).toBe(true)
  })

  it('hmacVerify rejects a tampered payload, wrong secret, and bad length', () => {
    const sig = hmacSign('payload', 'secret')
    expect(hmacVerify('payload!', sig, 'secret')).toBe(false)
    expect(hmacVerify('payload', sig, 'other')).toBe(false)
    expect(hmacVerify('payload', `${sig}extra`, 'secret')).toBe(false)
  })

  it('randomBytesBase64 / randomHex produce distinct values of the right shape', () => {
    expect(randomBytesBase64(16)).not.toBe(randomBytesBase64(16))
    expect(randomHex(16)).toHaveLength(32)
    expect(randomHex(16)).toMatch(/^[0-9a-f]+$/)
  })

  it('constantTimeEq matches equal strings and rejects different / unequal-length', () => {
    expect(constantTimeEq('abc', 'abc')).toBe(true)
    expect(constantTimeEq('abc', 'abd')).toBe(false)
    expect(constantTimeEq('abc', 'abcd')).toBe(false)
  })

  it('reports no native crypto when the NAPI binary is absent', () => {
    expect(hasNativeCrypto()).toBe(false)
  })
})

describe('security/crypto > NAPI preinstall path', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__reamNapi')
    vi.resetModules()
  })

  it('adopts a well-shaped preinstalled NAPI and delegates to it', async () => {
    const calls: string[] = []
    Reflect.set(globalThis, '__reamNapi', {
      hmacSign: () => {
        calls.push('sign')
        return 'napi-sig'
      },
      hmacVerify: () => true,
      randomBytesBase64: () => 'r',
      randomHex: () => 'h',
      constantTimeEq: () => true,
    })
    vi.resetModules()
    const mod = await import('../../src/security/crypto.js')
    expect(mod.hasNativeCrypto()).toBe(true)
    expect(mod.hmacSign('x', 'y')).toBe('napi-sig')
    expect(calls).toContain('sign')
  })

  it('delegates every call, and rethrows an engine failure under its code', async () => {
    const failed = new Error(JSON.stringify({ code: 'E_CRYPTO_FAILED', message: 'HMAC key error' }))
    Reflect.set(globalThis, '__reamNapi', {
      hmacSign: () => {
        throw failed
      },
      hmacVerify: () => false,
      randomBytesBase64: (len: number) => `b${len}`,
      randomHex: (len: number) => `h${len}`,
      constantTimeEq: () => true,
    })
    vi.resetModules()
    const mod = await import('../../src/security/crypto.js')
    expect(() => mod.hmacSign('x', 'y')).toThrow(
      expect.objectContaining({
        code: 'E_CRYPTO_FAILED',
        message: 'HMAC key error',
        cause: failed,
      }),
    )
    expect(mod.hmacVerify('x', 'sig', 'y')).toBe(false)
    expect(mod.randomBytesBase64(4)).toBe('b4')
    expect(mod.randomHex(4)).toBe('h4')
  })

  it('ignores a malformed preinstalled NAPI (missing functions) and uses the fallback', async () => {
    Reflect.set(globalThis, '__reamNapi', { hmacSign: () => 'nope' }) // incomplete shape
    vi.resetModules()
    const mod = await import('../../src/security/crypto.js')
    expect(mod.hasNativeCrypto()).toBe(false)
  })
})

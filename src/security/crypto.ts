/**
 * Crypto facade — resolves Rust NAPI bindings at load time.
 * If the binary isn't available, falls back to Node.js crypto.
 *
 * Usage:
 *   import { hmacSign, hmacVerify, randomHex, constantTimeEq } from './crypto.js'
 */

import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

interface NapiCrypto {
  hmacSign(data: string, secret: string): string
  hmacVerify(data: string, signature: string, secret: string): boolean
  randomBytesBase64(len: number): string
  randomHex(len: number): string
  constantTimeEq(a: string, b: string): boolean
  argon2Hash(password: string): string
  argon2Verify(password: string, hash: string): boolean
  bcryptHash(password: string, rounds?: number): string
  bcryptVerify(password: string, hash: string): boolean
}

let napi: NapiCrypto | null = null

try {
  // Attempt to load the NAPI binary (set by the app's server.ts loader)
  if (globalThis.__reamNapi) {
    napi = globalThis.__reamNapi
  }
} catch { /* binary not available */ }

/** @internal Set the NAPI bindings (called once by the NAPI loader). */
export function _setNapi(bindings: NapiCrypto): void {
  napi = bindings
}

/** Check if Rust NAPI crypto is available. */
export function hasNativeCrypto(): boolean {
  return napi !== null
}

// ─── Exports ────────────────────────────────────────────────

export function hmacSign(data: string, secret: string): string {
  if (napi) return napi.hmacSign(data, secret)
  return createHmac('sha256', secret).update(data).digest('base64url')
}

export function hmacVerify(data: string, signature: string, secret: string): boolean {
  if (napi) return napi.hmacVerify(data, signature, secret)
  const expected = createHmac('sha256', secret).update(data).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function randomBytesBase64(len: number): string {
  if (napi) return napi.randomBytesBase64(len)
  return nodeRandomBytes(len).toString('base64url')
}

export function randomHex(len: number): string {
  if (napi) return napi.randomHex(len)
  return nodeRandomBytes(len).toString('hex')
}

export function constantTimeEq(a: string, b: string): boolean {
  if (napi) return napi.constantTimeEq(a, b)
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// ─── Hashing ────────────────────────────────────────────────

export function argon2Hash(password: string): string | null {
  if (napi) return napi.argon2Hash(password)
  return null // no fallback — use ScryptDriver instead
}

export function argon2Verify(password: string, hash: string): boolean | null {
  if (napi) return napi.argon2Verify(password, hash)
  return null
}

export function bcryptHash(password: string, rounds?: number): string | null {
  if (napi) return napi.bcryptHash(password, rounds)
  return null
}

export function bcryptVerify(password: string, hash: string): boolean | null {
  if (napi) return napi.bcryptVerify(password, hash)
  return null
}

declare global {
  // biome-ignore lint/style/noVar: NAPI bridge
  var __reamNapi: NapiCrypto | undefined
}

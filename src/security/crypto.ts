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
}

let napi: NapiCrypto | null = null

try {
  // Optional pre-install path: a NAPI loader may set `globalThis.__reamNapi`
  // before this module loads. We validate the shape rather than declare a
  // global `var`, so the loader contract stays runtime-only.
  const preinstalled = readPreinstalledNapi()
  if (preinstalled) napi = preinstalled
} catch {
  /* binary not available */
}

/** @internal Set the NAPI bindings (called once by the NAPI loader). */
export function setNapi(bindings: NapiCrypto): void {
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

function readPreinstalledNapi(): NapiCrypto | null {
  // `globalThis` is typed without an index signature, so we go through Reflect
  // and validate the shape downstream — no global `var` declaration needed.
  const candidate: unknown = Reflect.get(globalThis, '__reamNapi')
  return isNapiCrypto(candidate) ? candidate : null
}

function isNapiCrypto(value: unknown): value is NapiCrypto {
  if (typeof value !== 'object' || value === null) return false
  return (
    hasFn(value, 'hmacSign') &&
    hasFn(value, 'hmacVerify') &&
    hasFn(value, 'randomBytesBase64') &&
    hasFn(value, 'randomHex') &&
    hasFn(value, 'constantTimeEq')
  )
}

function hasFn<K extends string>(
  value: object,
  key: K,
): value is Record<K, (...args: unknown[]) => unknown> {
  return key in value && typeof Reflect.get(value, key) === 'function'
}

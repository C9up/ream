/**
 * Signed URLs — HMAC-SHA256 with expiration.
 * Uses Rust NAPI via crypto facade when available.
 */

import { constantTimeEq, hmacSign } from './crypto.js'

export interface SignedUrlConfig {
  secret: string
}

export class SignedUrl {
  #secret: string

  constructor(config: SignedUrlConfig) {
    this.#secret = config.secret
  }

  make(path: string, options?: { expiresIn?: string | number; purpose?: string }): string {
    const url = new URL(path, 'http://localhost')
    // Audit 2026-05-22: `expiresIn !== undefined` instead of truthy check.
    // `expiresIn: 0` previously fell through the falsy branch and produced
    // an URL with no `expires` param — a never-expiring signed URL when the
    // caller explicitly asked for "expires immediately". The new check
    // honours 0 (and any other numeric input) by stamping the expires param;
    // verify() then rejects it as soon as the wall clock advances.
    if (options?.expiresIn !== undefined) {
      url.searchParams.set(
        'expires',
        String(Math.floor(Date.now() / 1000) + parseExpiry(options.expiresIn)),
      )
    }
    if (options?.purpose) {
      url.searchParams.set('purpose', options.purpose)
    }
    url.searchParams.set('signature', hmacSign(url.pathname + url.search, this.#secret))
    return url.pathname + url.search
  }

  verify(urlString: string, purpose?: string): boolean {
    const url = new URL(urlString, 'http://localhost')
    const providedSig = url.searchParams.get('signature')
    if (!providedSig) return false
    const expires = url.searchParams.get('expires')
    if (expires && Math.floor(Date.now() / 1000) > parseInt(expires, 10)) return false
    if (purpose && url.searchParams.get('purpose') !== purpose) return false

    url.searchParams.delete('signature')
    const expectedSig = hmacSign(url.pathname + url.search, this.#secret)
    return constantTimeEq(providedSig, expectedSig)
  }
}

function parseExpiry(value: string | number): number {
  if (typeof value === 'number') return value
  const match = value.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 3600
  const [, digits, unit] = match
  const num = parseInt(digits ?? '0', 10)
  switch (unit) {
    case 's':
      return num
    case 'm':
      return num * 60
    case 'h':
      return num * 3600
    case 'd':
      return num * 86400
    default:
      return 3600
  }
}

/**
 * Signed URLs — HMAC-SHA256 with expiration.
 * Uses Rust NAPI via crypto facade when available.
 */

import { hmacSign, constantTimeEq } from './crypto.js'

export interface SignedUrlConfig {
  secret: string
}

export class SignedUrl {
  private secret: string

  constructor(config: SignedUrlConfig) {
    this.secret = config.secret
  }

  make(path: string, options?: { expiresIn?: string | number; purpose?: string }): string {
    const url = new URL(path, 'http://localhost')
    if (options?.expiresIn) {
      url.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + parseExpiry(options.expiresIn)))
    }
    if (options?.purpose) {
      url.searchParams.set('purpose', options.purpose)
    }
    url.searchParams.set('signature', hmacSign(url.pathname + url.search, this.secret))
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
    const expectedSig = hmacSign(url.pathname + url.search, this.secret)
    return constantTimeEq(providedSig, expectedSig)
  }
}

function parseExpiry(value: string | number): number {
  if (typeof value === 'number') return value
  const match = value.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 3600
  const num = parseInt(match[1], 10)
  switch (match[2]) {
    case 's': return num
    case 'm': return num * 60
    case 'h': return num * 3600
    case 'd': return num * 86400
    default: return 3600
  }
}

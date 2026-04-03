/**
 * Signed URLs — generate and verify tamper-proof URLs with expiration.
 *
 * Usage:
 *   const url = signedUrl.make('/download/report.pdf', { expiresIn: '1h' })
 *   // → /download/report.pdf?signature=abc&expires=1234567890
 *
 *   signedUrl.verify(url) // true or false
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SignedUrlConfig {
  secret: string
}

export class SignedUrl {
  private secret: string

  constructor(config: SignedUrlConfig) {
    this.secret = config.secret
  }

  /** Generate a signed URL with optional expiration. */
  make(path: string, options?: { expiresIn?: string | number; purpose?: string }): string {
    const url = new URL(path, 'http://localhost')

    if (options?.expiresIn) {
      const expiresAt = Math.floor(Date.now() / 1000) + parseExpiry(options.expiresIn)
      url.searchParams.set('expires', String(expiresAt))
    }

    if (options?.purpose) {
      url.searchParams.set('purpose', options.purpose)
    }

    const signature = this.sign(url.pathname + url.search)
    url.searchParams.set('signature', signature)

    return url.pathname + url.search
  }

  /** Verify a signed URL. */
  verify(urlString: string, purpose?: string): boolean {
    const url = new URL(urlString, 'http://localhost')
    const providedSig = url.searchParams.get('signature')
    if (!providedSig) return false

    // Check expiration
    const expires = url.searchParams.get('expires')
    if (expires) {
      const expiresAt = parseInt(expires, 10)
      if (Math.floor(Date.now() / 1000) > expiresAt) return false
    }

    // Check purpose
    if (purpose) {
      const urlPurpose = url.searchParams.get('purpose')
      if (urlPurpose !== purpose) return false
    }

    // Rebuild URL without signature for verification
    url.searchParams.delete('signature')
    const expectedSig = this.sign(url.pathname + url.search)

    // Constant-time comparison
    const a = Buffer.from(providedSig)
    const b = Buffer.from(expectedSig)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url')
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

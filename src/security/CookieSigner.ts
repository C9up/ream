/**
 * Cookie signing and encryption — tamper-proof cookies.
 *
 * - Signed: HMAC-SHA256 appended, detects tampering
 * - Encrypted: AES-256-GCM, content hidden + tamper-proof
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

export class CookieSigner {
  private secret: Buffer

  constructor(secret: string) {
    // Derive a 32-byte key from the secret
    this.secret = Buffer.from(createHmac('sha256', secret).update('cookie-key').digest())
  }

  /** Sign a cookie value. Returns 'value.signature'. */
  sign(value: string): string {
    const sig = createHmac('sha256', this.secret).update(value).digest('base64url')
    return `${value}.${sig}`
  }

  /** Verify and extract a signed cookie. Returns null if invalid. */
  unsign(signed: string): string | null {
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) return null
    const value = signed.slice(0, lastDot)
    const sig = signed.slice(lastDot + 1)
    const expected = createHmac('sha256', this.secret).update(value).digest('base64url')

    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return value
  }

  /** Encrypt a cookie value with AES-256-GCM. */
  encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`
  }

  /** Decrypt an encrypted cookie. Returns null if invalid/tampered. */
  decrypt(encrypted: string): string | null {
    const parts = encrypted.split('.')
    if (parts.length !== 3) return null
    try {
      const iv = Buffer.from(parts[0], 'base64url')
      const data = Buffer.from(parts[1], 'base64url')
      const tag = Buffer.from(parts[2], 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.secret, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }
}

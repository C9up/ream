/**
 * Cookie signing and encryption.
 *
 * Uses Rust NAPI (hmac_sign/hmac_verify) when available,
 * falls back to Node.js crypto.
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

export class CookieSigner {
  private secret: string
  private keyBuffer: Buffer

  constructor(secret: string) {
    this.secret = secret
    this.keyBuffer = Buffer.from(createHmac('sha256', secret).update('cookie-key').digest())
  }

  sign(value: string): string {
    const napi = globalThis.__reamSecurityNapi
    if (napi) {
      return `${value}.${napi.hmacSign(value, this.secret)}`
    }
    const sig = createHmac('sha256', this.keyBuffer).update(value).digest('base64url')
    return `${value}.${sig}`
  }

  unsign(signed: string): string | null {
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) return null
    const value = signed.slice(0, lastDot)
    const sig = signed.slice(lastDot + 1)

    const napi = globalThis.__reamSecurityNapi
    if (napi) {
      return napi.hmacVerify(value, sig, this.secret) ? value : null
    }

    const expected = createHmac('sha256', this.keyBuffer).update(value).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return value
  }

  encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.keyBuffer, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`
  }

  decrypt(encrypted: string): string | null {
    const parts = encrypted.split('.')
    if (parts.length !== 3) return null
    try {
      const iv = Buffer.from(parts[0], 'base64url')
      const data = Buffer.from(parts[1], 'base64url')
      const tag = Buffer.from(parts[2], 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.keyBuffer, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }
}

declare global {
  // biome-ignore lint/style/noVar: global declaration
  var __reamSecurityNapi: {
    hmacSign: (data: string, secret: string) => string
    hmacVerify: (data: string, signature: string, secret: string) => boolean
    randomBytesBase64: (len: number) => string
    randomHex: (len: number) => string
    argon2Hash: (password: string) => string
    argon2Verify: (password: string, hash: string) => boolean
    bcryptHash: (password: string, rounds?: number) => string
    bcryptVerify: (password: string, hash: string) => boolean
    constantTimeEq: (a: string, b: string) => boolean
  } | undefined
}

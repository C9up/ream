/**
 * Cookie signing and encryption.
 * Uses Rust NAPI via crypto facade when available.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { hmacSign, hmacVerify } from './crypto.js'

export class CookieSigner {
  private secret: string
  private keyBuffer: Buffer

  constructor(secret: string) {
    this.secret = secret
    // Derive a 32-byte key for AES-256-GCM
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    this.keyBuffer = Buffer.from(createHmac('sha256', secret).update('cookie-key').digest())
  }

  sign(value: string): string {
    const sig = hmacSign(value, this.secret)
    return `${value}.${sig}`
  }

  unsign(signed: string): string | null {
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) return null
    const value = signed.slice(0, lastDot)
    const sig = signed.slice(lastDot + 1)
    return hmacVerify(value, sig, this.secret) ? value : null
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

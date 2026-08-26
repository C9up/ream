/**
 * Cookie signing and encryption.
 * Uses Rust NAPI via crypto facade when available.
 *
 * NAMED DEVIATION — the wire format is NOT AdonisJS's.
 *
 * AdonisJS encrypts with `aes-256-cbc` and appends its own HMAC
 * (`base64url(payload).base64url(iv).hmac`). Ream uses `aes-256-gcm`, where
 * authentication is part of the cipher rather than a second primitive bolted on
 * — encrypt-then-MAC assembled by hand is a well-known source of subtle breaks,
 * and there is no reason to reproduce it.
 *
 * The consequence, stated plainly: a cookie encrypted by an AdonisJS app cannot
 * be decrypted here. Migrating an app invalidates the encrypted cookies already
 * in users' browsers — they are signed out once, at deploy. Everything the app
 * CALLS (`encrypt` / `decrypt` / `sign` / `unsign`, with purpose and expiry)
 * behaves the same.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { hmacSign, hmacVerify } from './crypto.js'

/** Raised when no APP_KEY is configured (AdonisJS `E_MISSING_APP_KEY`). */
export class E_MISSING_APP_KEY extends Error {
  readonly code = 'E_MISSING_APP_KEY' as const
  constructor() {
    super('Missing APP_KEY. Set it in your environment before encrypting anything.')
    this.name = 'E_MISSING_APP_KEY'
  }
}

/** Raised when the APP_KEY is too short to be worth having. */
export class E_INSECURE_APP_KEY extends Error {
  readonly code = 'E_INSECURE_APP_KEY' as const
  constructor() {
    super('APP_KEY is too short — it must be at least 16 characters.')
    this.name = 'E_INSECURE_APP_KEY'
  }
}

/** The envelope carried inside an encrypted or signed value. */
interface Envelope {
  /** The payload. */
  m: string
  /** Epoch-ms expiry, when one was given. */
  e?: number
  /** The purpose it was sealed for, when one was given. */
  p?: string
}

export class CookieSigner {
  #secret: string
  #keyBuffer: Buffer

  constructor(secret: string) {
    // Validated as AdonisJS does: an absent or trivially short key is a
    // configuration error, not something to discover at decrypt time.
    if (typeof secret !== 'string' || secret.length === 0) throw new E_MISSING_APP_KEY()
    if (secret.length < 16) throw new E_INSECURE_APP_KEY()
    this.#secret = secret
    // Derive a 32-byte key for AES-256-GCM via HKDF-like derivation
    this.#keyBuffer = Buffer.from(createHmac('sha256', secret).update('cookie-key').digest())
  }

  /**
   * Wrap a payload with its expiry and purpose.
   *
   * `purpose` is what stops a value sealed for one use being replayed into
   * another — a password-reset token presented as a session cookie fails here
   * rather than being honoured.
   */
  #seal(value: string, expiresIn?: number, purpose?: string): string {
    const envelope: Envelope = { m: value }
    if (expiresIn !== undefined) envelope.e = Date.now() + expiresIn
    if (purpose !== undefined) envelope.p = purpose
    return JSON.stringify(envelope)
  }

  /**
   * Unwrap a sealed payload, refusing an expired one or the wrong purpose.
   *
   * Anything that is not an envelope is refused rather than handed back.
   * `#seal` only ever produces one, so a non-envelope did not come from this
   * class — and returning it would skip the expiry and purpose checks below,
   * which is precisely the downgrade those checks exist to prevent. Failing
   * closed costs a value nothing here produced; failing open costs the
   * guarantee that a token sealed for one use cannot be replayed into another.
   */
  #open(raw: string, purpose?: string): string | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const envelope = parsed as Envelope
    if (typeof envelope.m !== 'string') return null
    if (envelope.e !== undefined && envelope.e < Date.now()) return null
    if ((envelope.p ?? undefined) !== purpose) return null
    return envelope.m
  }

  /**
   * Sign a value (AdonisJS `Encryption.verifier.sign`).
   *
   * `expiresIn` is in milliseconds; `purpose` scopes the signature so it cannot
   * be replayed somewhere else.
   */
  sign(value: string, expiresIn?: number, purpose?: string): string {
    const sealed = Buffer.from(this.#seal(value, expiresIn, purpose)).toString('base64url')
    const sig = hmacSign(sealed, this.#secret)
    return `${sealed}.${sig}`
  }

  /** Verify and unwrap, returning null when tampered, expired, or mis-purposed. */
  unsign(signed: string, purpose?: string): string | null {
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) return null
    const sealed = signed.slice(0, lastDot)
    const sig = signed.slice(lastDot + 1)
    if (!hmacVerify(sealed, sig, this.#secret)) return null
    try {
      return this.#open(Buffer.from(sealed, 'base64url').toString('utf8'), purpose)
    } catch {
      return null
    }
  }

  encrypt(value: string, expiresIn?: number, purpose?: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#keyBuffer, iv)
    const sealed = this.#seal(value, expiresIn, purpose)
    const encrypted = Buffer.concat([cipher.update(sealed, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`
  }

  decrypt(encrypted: string, purpose?: string): string | null {
    const parts = encrypted.split('.')
    if (parts.length !== 3) return null
    try {
      const iv = Buffer.from(parts[0], 'base64url')
      const data = Buffer.from(parts[1], 'base64url')
      const tag = Buffer.from(parts[2], 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.#keyBuffer, iv)
      decipher.setAuthTag(tag)
      const raw = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      return this.#open(raw, purpose)
    } catch {
      return null
    }
  }
}

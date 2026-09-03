/**
 * Cookie signing and encryption.
 * Uses Rust NAPI via crypto facade when available.
 *
 * The cipher is `aes-256-gcm`, where authentication is part of the cipher
 * rather than a second primitive bolted on: encrypt-then-MAC assembled by hand
 * is a well-known source of subtle breaks.
 *
 * That is upstream's own current choice, not a divergence from it — v7 ships
 * AES-256-GCM, ChaCha20-Poly1305 and AES-SIV as first-class drivers, and its
 * documented example configures `aes256gcm` as the default. The CBC + HMAC
 * construction lives on there under the name `legacy`, described in its own
 * source as maintaining compatibility with the OLD v6 format.
 *
 * The consequence, stated plainly: a cookie encrypted by a v6-era application
 * cannot be decrypted here — those users are signed out once, at deploy. The
 * same is true of upstream v7 unless the legacy driver is configured. Should
 * that migration path ever be wanted, the answer is the one taken there: an
 * additional, explicitly named legacy reader — never a downgrade of the
 * default.
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

/** Raised when the APP_KEY is too short, or is a value everyone already has. */
export class E_INSECURE_APP_KEY extends Error {
  readonly code = 'E_INSECURE_APP_KEY' as const
  constructor(reason = 'it must be at least 16 characters') {
    super(`APP_KEY is not usable — ${reason}.`)
    this.name = 'E_INSECURE_APP_KEY'
  }
}

/**
 * Keys that appear in scaffolding, documentation and tutorials.
 *
 * A key anyone can read is not a secret: with it, cookies, sessions, CSRF
 * tokens and signed URLs can all be forged. Refusing them costs a developer
 * one `ream generate:key` and costs an attacker everything.
 */
const PUBLICLY_KNOWN_KEYS = new Set([
  'change-me-to-a-unique-32+-byte-secret!!',
  'change-me',
  'your-app-key-here',
  'secret',
])

/** The envelope carried inside an encrypted or signed value. */
interface Envelope {
  /**
   * The payload. Any JSON value, not just a string: AdonisJS' verifier signs
   * whatever you hand it, and a caller signing `{ id: 1 }` should not have to
   * stringify it first.
   */
  m: unknown
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
    if (PUBLICLY_KNOWN_KEYS.has(secret.trim().toLowerCase())) {
      throw new E_INSECURE_APP_KEY(
        'it is a placeholder from the scaffolding, which everyone can read. Run `ream generate:key`',
      )
    }
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
  #seal(value: unknown, expiresIn?: number, purpose?: string): string {
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
  #open(raw: string, purpose?: string): unknown {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const envelope = parsed as Envelope
    // The KEY must be there, whatever it holds — that is what distinguishes an
    // envelope from an arbitrary JSON document, and a signed `null` or `0` is a
    // legitimate payload.
    if (!('m' in envelope)) return null
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
  sign(value: unknown, expiresIn?: number, purpose?: string): string {
    const sealed = Buffer.from(this.#seal(value, expiresIn, purpose)).toString('base64url')
    const sig = hmacSign(sealed, this.#secret)
    return `${sealed}.${sig}`
  }

  /** Verify and unwrap, returning null when tampered, expired, or mis-purposed. */
  unsign<T = string>(signed: string, purpose?: string): T | null {
    const lastDot = signed.lastIndexOf('.')
    if (lastDot === -1) return null
    const sealed = signed.slice(0, lastDot)
    const sig = signed.slice(lastDot + 1)
    if (!hmacVerify(sealed, sig, this.#secret)) return null
    try {
      return this.#open(Buffer.from(sealed, 'base64url').toString('utf8'), purpose) as T | null
    } catch {
      return null
    }
  }

  /**
   * The cipher in use (AdonisJS `Encryption.algorithm`).
   *
   * `aes-256-gcm`, not upstream's `aes-256-cbc` — see the deviation at the top
   * of this file.
   */
  get algorithm(): 'aes-256-gcm' {
    return 'aes-256-gcm'
  }

  /**
   * base64url helpers (AdonisJS `Encryption.base64`).
   *
   * url-safe and unpadded, which is what every value this class produces uses
   * — a signed or encrypted payload travels in a cookie or a URL, where `+`,
   * `/` and `=` do not survive. `decode` answers `null` on anything that does
   * not round-trip rather than handing back mangled bytes.
   */
  get base64(): {
    encode(value: string): string
    decode(value: string): string | null
    urlEncode(value: string): string
    urlDecode(value: string): string | null
  } {
    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url')
    const decode = (value: string): string | null => {
      const out = Buffer.from(value, 'base64url').toString('utf8')
      return Buffer.from(out, 'utf8').toString('base64url') === value ? out : null
    }
    return { encode, decode, urlEncode: encode, urlDecode: decode }
  }

  /**
   * Sign and verify WITHOUT encrypting (AdonisJS `Encryption.verifier`).
   *
   * The same `sign` / `unsign` this class already exposes, under the name and
   * shape upstream puts them: an app calling `encryption.verifier.sign(...)`
   * found nothing here.
   */
  get verifier(): {
    sign(payload: unknown, expiresIn?: number, purpose?: string): string
    unsign<T = string>(payload: string, purpose?: string): T | null
  } {
    return {
      sign: (payload, expiresIn, purpose) => this.sign(payload, expiresIn, purpose),
      unsign: <T>(payload: string, purpose?: string) => this.unsign<T>(payload, purpose),
    }
  }

  /**
   * Another signer on a different secret (AdonisJS `Encryption.child`).
   *
   * What key rotation is built on: keep the old secret's signer around to read
   * values already in the wild while the new one writes.
   */
  child(secret?: string): CookieSigner {
    return new CookieSigner(secret ?? this.#secret)
  }

  encrypt(value: unknown, expiresIn?: number, purpose?: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#keyBuffer, iv)
    const sealed = this.#seal(value, expiresIn, purpose)
    const encrypted = Buffer.concat([cipher.update(sealed, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`
  }

  decrypt<T = string>(encrypted: string, purpose?: string): T | null {
    // Destructured rather than indexed, and `extra` is what keeps the old
    // length check honest: three names bind on a four-part string too, so the
    // fourth has to be looked at to reject it.
    const [ivPart, dataPart, tagPart, extra] = encrypted.split('.')
    if (
      ivPart === undefined ||
      dataPart === undefined ||
      tagPart === undefined ||
      extra !== undefined
    ) {
      return null
    }
    try {
      const iv = Buffer.from(ivPart, 'base64url')
      const data = Buffer.from(dataPart, 'base64url')
      const tag = Buffer.from(tagPart, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.#keyBuffer, iv)
      decipher.setAuthTag(tag)
      const raw = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      return this.#open(raw, purpose) as T | null
    } catch {
      return null
    }
  }
}

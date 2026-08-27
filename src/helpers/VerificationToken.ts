/**
 * The base class for opaque, single-use tokens — password resets, email
 * verification, magic links.
 *
 * The shape it enforces is the point. The token handed to the user is
 * `<identifier>.<secret>`, and only the SHA-256 of the secret is stored. A
 * database leak therefore yields hashes, not usable tokens, and the identifier
 * travels alongside so verification is one indexed lookup rather than a scan.
 *
 * Comparison goes through a constant-time equality: comparing hashes with `===`
 * leaks their common prefix through timing, which is enough to forge one.
 *
 * Ported from `@adonisjs/core/helpers` — subclass it and add the persistence.
 */

import { createHash } from 'node:crypto'
import { Secret } from '../env/Secret.js'
import { base64 } from './base64.js'
import { seconds } from './duration.js'
import { safeEqual } from './safeEqual.js'
import { random } from './string.js'

export abstract class VerificationToken {
  /** Row identifier, as stored. */
  declare identifier: string | number | bigint
  /** Who the token belongs to. */
  declare tokenableId: string | number | bigint
  /** SHA-256 of the secret — the only half that is persisted. */
  declare hash: string
  /** When the token stops being accepted. */
  declare expiresAt: Date
  /** The full token, present only on the instance that just created it. */
  value?: Secret<string>

  /**
   * Split a presented token back into its identifier and secret.
   *
   * Returns `null` for anything malformed rather than throwing: the input is
   * attacker-controlled, and every rejection should look the same.
   */
  static decode(value: string): { identifier: string; secret: Secret<string> } | null {
    if (typeof value !== 'string' || value.length === 0) return null
    const [identifier, ...rest] = value.split('.')
    if (!identifier || rest.length === 0) return null
    const decodedIdentifier = base64.urlDecode(identifier)
    const decodedSecret = base64.urlDecode(rest.join('.'))
    if (!decodedIdentifier || !decodedSecret) return null
    return { identifier: decodedIdentifier, secret: new Secret(decodedSecret) }
  }

  /** A fresh secret and its hash. */
  static seed(size: number): { secret: Secret<string>; hash: string } {
    const secret = new Secret(random(size))
    return {
      secret,
      hash: createHash('sha256').update(secret.release()).digest('hex'),
    }
  }

  /** A seed plus the owner and an expiry, ready to be persisted. */
  static createTransientToken(
    userId: string | number | bigint,
    size: number,
    expiresIn: string | number,
  ): {
    userId: string | number | bigint
    expiresAt: Date
    secret: Secret<string>
    hash: string
  } {
    const expiresAt = new Date()
    expiresAt.setSeconds(expiresAt.getSeconds() + seconds.parse(expiresIn))
    return { userId, expiresAt, ...VerificationToken.seed(size) }
  }

  /** Build the public `<identifier>.<secret>` value, after the row has an id. */
  protected computeValue(secret: Secret<string>): void {
    this.value = new Secret(
      `${base64.urlEncode(String(this.identifier))}.${base64.urlEncode(secret.release())}`,
    )
  }

  /** Whether the expiry has passed. */
  isExpired(): boolean {
    return this.expiresAt < new Date()
  }

  /** Whether `secret` hashes to the stored hash, compared in constant time. */
  verify(secret: Secret<string>): boolean {
    const candidate = createHash('sha256').update(secret.release()).digest('hex')
    return safeEqual(this.hash, candidate)
  }
}

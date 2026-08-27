/**
 * Wrap a value with an expiry and a purpose before it is signed or encrypted.
 *
 * The signature on a token proves it was issued by this application. It does
 * NOT prove the token is still valid, nor that it was issued for the job it is
 * being presented for — a signed password-reset token would otherwise pass as a
 * signed email-verification token. Those two claims travel inside the payload,
 * which is why they are added before signing rather than checked after.
 *
 * Ported from `@poppinss/utils`; `CookieSigner` and `SignedUrl` sign what this
 * produces.
 */

import { milliseconds } from './duration.js'

/** The envelope `build` emits and `verify` reads back. */
interface Envelope {
  message: unknown
  purpose?: string
  expiryDate?: string
}

export class MessageBuilder {
  /**
   * Serialise `message`, optionally stamped with an expiry and a purpose.
   *
   * @param expiresIn - a duration (`'2 hours'`) or a number of milliseconds.
   */
  build(message: unknown, expiresIn?: string | number, purpose?: string): string {
    const envelope: Envelope = { message }
    if (purpose !== undefined) envelope.purpose = purpose
    if (expiresIn !== undefined) {
      envelope.expiryDate = new Date(Date.now() + milliseconds.parse(expiresIn)).toISOString()
    }
    return JSON.stringify(envelope)
  }

  /**
   * Read an envelope back, or `null` when it is malformed, expired, or was
   * issued for a different purpose.
   *
   * Never throws: every failure is the same `null`, so a caller cannot
   * accidentally tell "tampered" from "expired" and leak which it was.
   */
  verify<T = unknown>(payload: string, purpose?: string): T | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    if (!('message' in parsed) || parsed.message === undefined) return null

    const envelopePurpose = 'purpose' in parsed ? parsed.purpose : undefined
    if (envelopePurpose !== purpose) return null

    if ('expiryDate' in parsed && typeof parsed.expiryDate === 'string') {
      const expiresAt = new Date(parsed.expiryDate)
      // An unparseable date counts as expired: a token whose expiry cannot be
      // read is a token whose expiry cannot be enforced.
      if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) return null
    }

    // The caller declares the shape it put in — the same contract as
    // `session.get<T>()`, over a payload that is untyped by nature.
    return parsed.message as T
  }
}

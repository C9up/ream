import { CookieSigner } from '../../security/CookieSigner.js'
import type { SessionDriver } from '../Session.js'

/**
 * Cookie session driver — stores session data in an encrypted cookie (AES-256-GCM).
 * Stateless on the server. Limited by cookie size (~4KB).
 * Requires a secret for encryption.
 */
export class CookieDriver implements SessionDriver {
  private signer: CookieSigner

  constructor(secret: string) {
    if (!secret) {
      throw new Error(
        'CookieDriver requires a secret for session encryption. Set session.secret in your config.',
      )
    }
    this.signer = new CookieSigner(secret)
  }

  async read(sessionId: string): Promise<Record<string, unknown> | null> {
    if (!sessionId) return null
    const decrypted = this.signer.decrypt(sessionId)
    if (!decrypted) return null
    try {
      return JSON.parse(decrypted)
    } catch {
      return null
    }
  }

  async write(_sessionId: string, _data: Record<string, unknown>, _ttl: number): Promise<void> {
    // Cookie driver writes via the response cookie — handled by middleware
  }

  async destroy(_sessionId: string): Promise<void> {
    // Cookie deletion handled by middleware setting maxAge=0
  }

  async touch(_sessionId: string, _ttl: number): Promise<void> {
    // Cookie renewal handled by middleware
  }

  /** Encode session data for cookie storage (encrypted). */
  encode(data: Record<string, unknown>): string {
    return this.signer.encrypt(JSON.stringify(data))
  }
}

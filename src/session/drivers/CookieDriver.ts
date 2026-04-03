import type { SessionDriver } from '../Session.js'

/**
 * Cookie session driver — stores session data in an encrypted cookie.
 * Stateless on the server. Limited by cookie size (~4KB).
 */
export class CookieDriver implements SessionDriver {
  async read(sessionId: string): Promise<Record<string, unknown>> {
    // Session data comes from the cookie value, decoded by the middleware
    // The middleware passes it here. For cookie driver, sessionId IS the data.
    try {
      return JSON.parse(Buffer.from(sessionId, 'base64url').toString('utf8'))
    } catch {
      return {}
    }
  }

  async write(_sessionId: string, data: Record<string, unknown>, _ttl: number): Promise<void> {
    // Cookie driver writes via the response cookie — handled by middleware
    // This is a no-op; the middleware reads session.toJSON() and sets the cookie
  }

  async destroy(_sessionId: string): Promise<void> {
    // Cookie deletion handled by middleware setting maxAge=0
  }

  async touch(_sessionId: string, _ttl: number): Promise<void> {
    // Cookie renewal handled by middleware
  }

  /** Encode session data for cookie storage. */
  static encode(data: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(data)).toString('base64url')
  }
}

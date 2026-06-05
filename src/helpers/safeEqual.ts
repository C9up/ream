import { timingSafeEqual } from 'node:crypto'

/**
 * Timing-safe comparison of two strings or buffers. Prevents timing attacks.
 *
 * @example
 * safeEqual('secret', 'secret') // true
 * safeEqual('secret', 'wrong')  // false
 */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = typeof a === 'string' ? Buffer.from(a) : a
  const bufB = typeof b === 'string' ? Buffer.from(b) : b
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

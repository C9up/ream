const STANDARD_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const URL_B64_RE = /^[A-Za-z0-9_-]*$/

/**
 * Encode a string or Buffer to standard base64.
 *
 * @example
 * base64.encode('hello') // 'aGVsbG8='
 */
function encode(value: string | Buffer): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value
  return buf.toString('base64')
}

/**
 * Decode a standard base64 string. Returns null on invalid input unless strict mode,
 * in which case it throws.
 *
 * @example
 * base64.decode('aGVsbG8=') // 'hello'
 * base64.decode('!!!') // null
 */
function decode(value: string, encoding: BufferEncoding = 'utf-8', strict = false): string | null {
  if (!STANDARD_B64_RE.test(value)) {
    if (strict) throw new Error(`Invalid base64 string: ${value}`)
    return null
  }
  try {
    return Buffer.from(value, 'base64').toString(encoding)
  } catch {
    if (strict) throw new Error(`Failed to decode base64 string: ${value}`)
    return null
  }
}

/**
 * Encode a string or Buffer to base64url (no padding, uses - and _ instead of + and /).
 *
 * @example
 * base64.urlEncode('hello') // 'aGVsbG8'
 */
function urlEncode(value: string | Buffer): string {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value
  return buf.toString('base64url')
}

/**
 * Decode a base64url string. Returns null on invalid input unless strict mode,
 * in which case it throws.
 *
 * @example
 * base64.urlDecode('aGVsbG8') // 'hello'
 * base64.urlDecode('!!!') // null
 */
function urlDecode(
  value: string,
  encoding: BufferEncoding = 'utf-8',
  strict = false,
): string | null {
  if (!URL_B64_RE.test(value)) {
    if (strict) throw new Error(`Invalid base64url string: ${value}`)
    return null
  }
  try {
    return Buffer.from(value, 'base64url').toString(encoding)
  } catch {
    if (strict) throw new Error(`Failed to decode base64url string: ${value}`)
    return null
  }
}

export const base64 = { encode, decode, urlEncode, urlDecode }

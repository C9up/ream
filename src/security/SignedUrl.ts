/**
 * Signed URLs — HMAC-SHA256 with expiration.
 * Uses Rust NAPI via crypto facade when available.
 */

import { E_INVALID_DURATION } from '../errors/codes.js'
import { durationToSeconds } from '../helpers/duration.js'
import { constantTimeEq, hmacSign } from './crypto.js'

export interface SignedUrlConfig {
  secret: string
}

export class SignedUrl {
  #secret: string

  constructor(config: SignedUrlConfig) {
    this.#secret = config.secret
  }

  /**
   * Sign `path` (a path, with or without a query string). The signature
   * covers exactly the string returned, without its trailing `signature`
   * parameter: the client must send it back byte for byte.
   */
  make(path: string, options?: { expiresIn?: string | number; purpose?: string }): string {
    const url = new URL(path, 'http://localhost')
    // `expiresIn !== undefined`, not a truthy check: `expiresIn: 0` means
    // "expires now", never "never expires".
    if (options?.expiresIn !== undefined) {
      url.searchParams.set(
        'expires',
        String(Math.floor(Date.now() / 1000) + parseExpiry(options.expiresIn)),
      )
    }
    if (options?.purpose) {
      url.searchParams.set('purpose', options.purpose)
    }
    // Serialised once, so the string signed is the string returned: the
    // query is in its `URLSearchParams` form whether or not a parameter was
    // set above.
    const query = url.searchParams.toString()
    const unsigned = query === '' ? url.pathname : `${url.pathname}?${query}`
    const signature = hmacSign(unsigned, this.#secret)
    return `${unsigned}${query === '' ? '?' : '&'}signature=${signature}`
  }

  /**
   * Check a signed URL: the raw `path?query` exactly as it was requested
   * (`request.url(true)`, Node's `req.url`).
   *
   * The string is never parsed as a URL. A URL parser turns `\` into `/`,
   * resolves `.` and `..` segments (`%2e%2e` too) and reads a leading `//x`
   * as a host, so the path it hands back is not the path the router matched:
   * `/users/7\..\5/verify` would verify with the signature of `/users/5/verify`
   * and run with `id = '7\..\5'`. The signature is checked over the exact
   * bytes received, minus the `signature` parameter, as upstream compares the
   * request's own path.
   */
  verify(urlString: string, purpose?: string): boolean {
    const parts = splitSignedUrl(urlString)
    if (parts === undefined) return false
    const params = new URLSearchParams(parts.query)
    const expiries = params.getAll('expires')
    const purposes = params.getAll('purpose')
    if (expiries.length > 1 || purposes.length > 1) return false
    const expires = expiries[0]
    if (expires !== undefined) {
      if (!/^\d+$/.test(expires)) return false
      if (Math.floor(Date.now() / 1000) > Number.parseInt(expires, 10)) return false
    }
    // Exact match both ways: a URL minted for `password-reset` must not pass a
    // check that names no purpose (or another one), and a purpose-less URL
    // must not pass a check that names one. An empty purpose is no purpose,
    // as in `make`.
    const signedPurpose = purposes[0] || undefined
    if (signedPurpose !== (purpose || undefined)) return false

    const unsigned = parts.query === '' ? parts.path : `${parts.path}?${parts.query}`
    return constantTimeEq(parts.signature, hmacSign(unsigned, this.#secret))
  }
}

/**
 * Split a raw signed URL into its path, its query without the `signature`
 * parameter (the other parameters kept as received, in order) and the
 * signature. `undefined` when there is no single non-empty signature, or when
 * the string holds a fragment, which a request target never does.
 */
function splitSignedUrl(
  urlString: string,
): { path: string; query: string; signature: string } | undefined {
  if (urlString.includes('#')) return undefined
  const mark = urlString.indexOf('?')
  if (mark === -1) return undefined
  const kept: string[] = []
  let signature: string | undefined
  for (const segment of urlString.slice(mark + 1).split('&')) {
    // `URLSearchParams` drops a leading `?`; a segment starting with one is a
    // parameter named `?…`, never the signature.
    const pair = segment.startsWith('?') ? undefined : new URLSearchParams(segment).entries().next()
    if (pair !== undefined && !pair.done && pair.value[0] === 'signature') {
      if (signature !== undefined) return undefined
      signature = pair.value[1]
    } else {
      kept.push(segment)
    }
  }
  if (signature === undefined || signature === '') return undefined
  return { path: urlString.slice(0, mark), query: kept.join('&'), signature }
}

/**
 * The lifetime of a signed URL in seconds. Read with the duration grammar
 * used everywhere else (`'30 minutes'`, `'1 week'`, `'2h'`), and refused when
 * it cannot be read: signing with a default instead turned "one week" into
 * one hour without a word.
 */
function parseExpiry(value: string | number): number {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new E_INVALID_DURATION([
      `Cannot read ${value} as a signed URL expiry: it must be a finite number of seconds.`,
    ])
  }
  return durationToSeconds(value, 'a signed URL expiry')
}

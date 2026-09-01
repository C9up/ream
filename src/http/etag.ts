/**
 * Entity tags, computed here rather than pulled in.
 *
 * The `etag` package is fifteen lines of hashing behind a dependency, and this
 * is the whole of what a response needs. The format is reproduced byte for
 * byte on purpose: an ETag is a cache key, and changing its shape would
 * invalidate every cached response in flight the day it shipped.
 *
 * `<hex length>-<27 chars of base64 sha1>`, quoted, with `W/` in front when
 * the caller asks for a weak one. The empty body has a fixed answer because
 * hashing nothing is the same work every time.
 */

import { createHash } from 'node:crypto'

/** base64 sha1 of the empty string, truncated as below — precomputed. */
const EMPTY = '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'

/** The tag for a response body (`etag` package parity, string or Buffer). */
export function etag(body: string | Buffer, options?: { weak?: boolean }): string {
  const tag = body.length === 0 ? EMPTY : entityTag(body)
  return options?.weak === true ? `W/${tag}` : tag
}

function entityTag(body: string | Buffer): string {
  const hash = createHash('sha1')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('base64')
    .slice(0, 27)
  // Byte length, not character count: a multi-byte body is longer on the wire
  // than its string length says.
  const length = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length
  return `"${length.toString(16)}-${hash}"`
}

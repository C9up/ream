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

/**
 * The tag for a file, from its metadata rather than its bytes.
 *
 * `W/"<size hex>-<mtime hex>"`, which is what the `etag` package produces for
 * a `Stats` and therefore what Express's `send` — and so every static file
 * server people have cached against — puts on a static asset. Weak because it
 * is derived from metadata: two files with the same size and mtime are
 * equivalent for caching, not provably byte-identical.
 *
 * The quotes are not decoration. RFC 9110 §8.8.3 defines an entity-tag as a
 * quoted string, and a bare hex digest is not one: a strict cache is entitled
 * to ignore it, which turns every conditional request back into a full
 * transfer.
 */
export function statTag(stat: { size: number; mtimeMs: number }): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

/**
 * Whether `If-None-Match` covers `tag` (RFC 9110 §13.1.2).
 *
 * The header is a LIST, and it is compared with the WEAK comparison function —
 * `W/"x"` and `"x"` match. Raw string equality against the whole header value
 * failed a client that sent two tags, and failed every client that sent back
 * the weak form of a strong tag, so both re-downloaded a file they already had.
 */
export function matchesIfNoneMatch(header: string | undefined, tag: string): boolean {
  if (!header || tag === '') return false
  if (header.trim() === '*') return true
  const bare = (value: string): string => (value.startsWith('W/') ? value.slice(2) : value)
  const current = bare(tag)
  return header.split(',').some((candidate) => bare(candidate.trim()) === current)
}

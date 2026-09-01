/**
 * Entity tags, byte for byte.
 *
 * An ETag is a cache key: change its shape and every cached response in flight
 * is invalidated the day it ships. These values were taken from the package
 * this replaced, so a client holding one still gets its 304.
 */
import { describe, expect, it } from 'vitest'
import { etag } from '../../src/http/etag.js'

describe('ream > etag', () => {
  it('answers the fixed tag for an empty body', () => {
    expect(etag('')).toBe('"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"')
    expect(etag(Buffer.alloc(0))).toBe('"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"')
  })

  it('uses hex length and 27 characters of base64 sha1', () => {
    expect(etag('hello')).toBe('"5-qvTGHdzF6KLavt4PO0gs2a6pQ00"')
  })

  it('counts bytes, not characters', () => {
    // Eleven characters, thirteen bytes — the length prefix has to say 13 (d).
    expect(etag('héllo wörld')).toMatch(/^"d-/)
  })

  it('marks a weak tag without changing the tag itself', () => {
    expect(etag('hello', { weak: true })).toBe(`W/${etag('hello')}`)
  })

  it('hashes a Buffer as its bytes', () => {
    expect(etag(Buffer.from('hello', 'utf8'))).toBe(etag('hello'))
  })

  it('gives different bodies different tags', () => {
    expect(etag('a')).not.toBe(etag('b'))
  })
})

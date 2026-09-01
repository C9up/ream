/**
 * Content types, matched against the package this replaced.
 *
 * `response.type('txt')` has to keep answering `text/plain; charset=utf-8`:
 * these values were taken from `mime-types` so nothing a caller relies on
 * moves.
 */
import { describe, expect, it } from 'vitest'
import { contentType, lookupType } from '../../src/http/mime.js'

describe('ream > contentType', () => {
  it('resolves an extension and appends the charset for text', () => {
    expect(contentType('txt')).toBe('text/plain; charset=utf-8')
    expect(contentType('html')).toBe('text/html; charset=utf-8')
    expect(contentType('json')).toBe('application/json; charset=utf-8')
    expect(contentType('js')).toBe('text/javascript; charset=utf-8')
  })

  it('leaves a binary type without one', () => {
    expect(contentType('png')).toBe('image/png')
    expect(contentType('pdf')).toBe('application/pdf')
    // XML declares its own encoding — the package agrees.
    expect(contentType('xml')).toBe('application/xml')
  })

  it('passes a full type through, charset rules included', () => {
    expect(contentType('text/plain')).toBe('text/plain; charset=utf-8')
    expect(contentType('image/png')).toBe('image/png')
  })

  it('keeps a charset the caller set', () => {
    expect(contentType('text/html; charset=iso-8859-1')).toBe('text/html; charset=iso-8859-1')
  })

  it('answers false for what it cannot resolve, so the caller can fall back', () => {
    // The response writes the raw input in that case rather than
    // `content-type: false`.
    expect(contentType('not-an-extension')).toBe(false)
    expect(contentType('')).toBe(false)
  })

  it('reads an extension off a filename', () => {
    expect(lookupType('archive.tar.gz')).toBe('application/gzip')
    expect(lookupType('.WEBP')).toBe('image/webp')
  })

  it('gives any +json suffix a charset', () => {
    expect(contentType('application/ld+json')).toBe('application/ld+json; charset=utf-8')
  })
})

import { describe, expect, it } from 'vitest'
import { safeDecodeFormComponent, safeDecodeURIComponent } from '../../src/http/urlDecode.js'

describe('ream > safeDecodeURIComponent', () => {
  it('decodes a normal URL-encoded value', () => {
    expect(safeDecodeURIComponent('hello%20world')).toBe('hello world')
  })

  it('returns the raw value when the input is malformed', () => {
    // Lone '%' triggers URIError inside decodeURIComponent.
    expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A')
  })

  it('handles already-decoded values transparently', () => {
    expect(safeDecodeURIComponent('plain')).toBe('plain')
  })
})

describe('ream > safeDecodeFormComponent', () => {
  it("converts '+' to spaces before decoding", () => {
    expect(safeDecodeFormComponent('foo+bar')).toBe('foo bar')
  })

  it('combines + replacement with percent-decoding', () => {
    expect(safeDecodeFormComponent('a+b%26c')).toBe('a b&c')
  })

  it('returns raw value when malformed', () => {
    expect(safeDecodeFormComponent('a+%XY')).toBe('a %XY')
  })
})

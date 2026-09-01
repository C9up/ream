/**
 * The table in `src/http/mime.ts` is generated from mime-db, and this is what
 * says so: every extension mime-types resolves, we resolve identically —
 * `lookupType` against its `lookup`, `contentType` against its `contentType`.
 *
 * The previous table was hand-written and its doc comment promised the same
 * parity, which is how `.yaml` came to go out as `Content-Type: yaml`. A claim
 * of parity is worth what its test is worth.
 *
 * mime-types is a devDependency, read here and by the generator only; the
 * framework itself imports neither it nor mime-db.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { contentType, lookupType } from '../../src/http/mime.js'

const require = createRequire(import.meta.url)
const mimeTypes: {
  types: Record<string, string>
  lookup: (input: string) => string | false
  contentType: (input: string) => string | false
} = require('mime-types')

const extensions = Object.keys(mimeTypes.types)

describe('mime > parity with mime-types', () => {
  it('covers every extension the package knows', () => {
    // Guards against a generator that silently emitted a truncated table.
    expect(extensions.length).toBeGreaterThan(1200)
    const missing = extensions.filter((ext) => lookupType(ext) === undefined)
    expect(missing).toEqual([])
  })

  it('resolves every extension to the same type', () => {
    const diverging = extensions.filter((ext) => lookupType(ext) !== mimeTypes.lookup(ext))
    expect(diverging).toEqual([])
  })

  it('builds the same Content-Type for every extension', () => {
    const diverging = extensions.filter((ext) => contentType(ext) !== mimeTypes.contentType(ext))
    expect(diverging).toEqual([])
  })

  it('applies the same charset rule to a type given directly', () => {
    const types = [...new Set(Object.values(mimeTypes.types))]
    const diverging = types.filter((type) => contentType(type) !== mimeTypes.contentType(type))
    expect(diverging).toEqual([])
  })

  it('resolves the extensions the hand-written table had dropped', () => {
    // The ones the audit named, kept explicit so a regression reads as itself
    // rather than as one row in a diff of 1239.
    expect(contentType('yaml')).toBe('text/yaml; charset=utf-8')
    expect(contentType('sql')).toBe('application/sql')
    expect(contentType('opus')).toBe('audio/ogg')
    expect(contentType('mpeg')).toBe('video/mpeg')
    expect(contentType('heif')).toBe('image/heif')
    expect(contentType('xhtml')).toBe('application/xhtml+xml')
    expect(contentType('apk')).toBe('application/vnd.android.package-archive')
  })

  it('still answers false for something that is not a type', () => {
    expect(contentType('')).toBe(false)
    expect(contentType('nope-not-an-extension')).toBe(false)
    expect(lookupType('nope-not-an-extension')).toBeUndefined()
  })

  it('keeps a charset the caller set', () => {
    expect(contentType('text/plain; charset=iso-8859-1')).toBe('text/plain; charset=iso-8859-1')
  })
})

import { describe, expect, it } from 'vitest'
import {
  getPath,
  hasPath,
  mergeDeep,
  omitPaths,
  pickPaths,
  setPath,
} from '../../src/utils/objectPath.js'

describe('objectPath > getPath', () => {
  const tree = {
    app: { key: 'secret', nested: { deep: 42 } },
    list: [{ id: 'a' }, { id: 'b' }],
    zero: 0,
    falsy: false,
  }

  it('reads a single-segment key', () => {
    expect(getPath(tree, 'app')).toEqual(tree.app)
  })

  it('reads a nested dot-path', () => {
    expect(getPath(tree, 'app.nested.deep')).toBe(42)
  })

  it('reads through array indices with bracket and dotted notation', () => {
    expect(getPath(tree, 'list[1].id')).toBe('b')
    expect(getPath(tree, 'list.0.id')).toBe('a')
  })

  it('returns the default when a segment is missing', () => {
    expect(getPath(tree, 'app.missing.deep', 'fallback')).toBe('fallback')
    expect(getPath(tree, 'nope', 'fallback')).toBe('fallback')
  })

  it('returns falsy leaf values as-is (not the default)', () => {
    expect(getPath(tree, 'zero', 99)).toBe(0)
    expect(getPath(tree, 'falsy', true)).toBe(false)
  })

  it('returns undefined (no default) for an absent path', () => {
    expect(getPath(tree, 'a.b.c')).toBeUndefined()
  })
})

describe('objectPath > hasPath', () => {
  const tree = { a: { b: { c: undefined } }, x: 1 }

  it('is true for an existing path even when the leaf is undefined', () => {
    expect(hasPath(tree, 'a.b.c')).toBe(true)
  })

  it('is false for a missing path', () => {
    expect(hasPath(tree, 'a.b.d')).toBe(false)
    expect(hasPath(tree, 'y')).toBe(false)
  })
})

describe('objectPath > setPath', () => {
  it('creates intermediate objects and sets the leaf', () => {
    const target: Record<string, unknown> = {}
    setPath(target, 'a.b.c', 1)
    expect(target).toEqual({ a: { b: { c: 1 } } })
  })

  it('overwrites a scalar in the path with an object instead of throwing', () => {
    const target: Record<string, unknown> = { a: 5 }
    setPath(target, 'a.b', 2)
    expect(target).toEqual({ a: { b: 2 } })
  })

  it('preserves sibling keys', () => {
    const target: Record<string, unknown> = { a: { keep: true } }
    setPath(target, 'a.added', 1)
    expect(target).toEqual({ a: { keep: true, added: 1 } })
  })
})

describe('objectPath > pickPaths', () => {
  const source = { user: { id: 1, name: 'x', secret: 's' }, other: true }

  it('picks nested branches, skipping absent paths', () => {
    expect(pickPaths(source, ['user.id', 'user.name', 'missing.key'])).toEqual({
      user: { id: 1, name: 'x' },
    })
  })

  it('picks a top-level key whole', () => {
    expect(pickPaths(source, ['other'])).toEqual({ other: true })
  })
})

describe('objectPath > omitPaths', () => {
  it('removes nested paths without mutating the source', () => {
    const source = { user: { id: 1, secret: 's' }, keep: true }
    const result = omitPaths(source, ['user.secret'])
    expect(result).toEqual({ user: { id: 1 }, keep: true })
    // Source is untouched (deep clone).
    expect(source.user.secret).toBe('s')
  })

  it('is a no-op for an absent path', () => {
    const source = { a: 1 }
    expect(omitPaths(source, ['b.c'])).toEqual({ a: 1 })
  })
})

describe('objectPath > mergeDeep', () => {
  it('deep-merges nested objects with source winning', () => {
    expect(mergeDeep({ a: { x: 1, y: 2 } }, { a: { y: 9, z: 3 } })).toEqual({
      a: { x: 1, y: 9, z: 3 },
    })
  })

  it('replaces arrays and scalars wholesale (no index merge)', () => {
    expect(mergeDeep({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] })
    expect(mergeDeep({ v: 1 }, { v: 2 })).toEqual({ v: 2 })
  })

  it('keeps the target when the source value is undefined', () => {
    expect(mergeDeep({ v: 1 }, { v: undefined })).toEqual({ v: 1 })
  })
})

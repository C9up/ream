/**
 * What the session shares with the request's view.
 *
 * A migrated AdonisJS template reads `{{ old('email') }}`,
 * `{{ flashMessages.get('errorsBag.email') }}` and `{{ session.get('cart') }}`
 * unchanged, and the `@error` / `@errors` / `@inputError` tags address flash
 * data by PATH — `has(['errorsBag', field])`. So the names and the path
 * semantics both have to match.
 */
import { describe, expect, it } from 'vitest'
import { ReadOnlyValuesStore } from '../../src/session/ReadOnlyValuesStore.js'

describe('ream > ReadOnlyValuesStore', () => {
  it('reads a plain key', () => {
    const store = new ReadOnlyValuesStore({ name: 'Ada' })
    expect(store.get('name')).toBe('Ada')
    expect(store.has('name')).toBe(true)
  })

  it('addresses a nested value by dotted path AND by array', () => {
    const store = new ReadOnlyValuesStore({ errorsBag: { email: 'required' } })
    expect(store.get('errorsBag.email')).toBe('required')
    expect(store.get(['errorsBag', 'email'])).toBe('required')
    expect(store.has(['errorsBag', 'email'])).toBe(true)
  })

  it('falls back to the default when any segment is missing', () => {
    const store = new ReadOnlyValuesStore({ a: { b: 1 } })
    expect(store.get('a.missing', 'd')).toBe('d')
    expect(store.get('missing.b', 'd')).toBe('d')
    expect(store.get('inputErrorsBag', {})).toEqual({})
    expect(store.has('nope')).toBe(false)
  })

  it('never walks the prototype chain', () => {
    const store = new ReadOnlyValuesStore({ a: 1 })
    expect(store.get('constructor')).toBeUndefined()
    expect(store.get('toString')).toBeUndefined()
    expect(store.has('__proto__')).toBe(false)
  })

  it('all() hands back a copy, so a template cannot mutate the store', () => {
    const store = new ReadOnlyValuesStore({ a: 1 })
    const copy = store.all()
    copy.a = 99
    expect(store.get('a')).toBe(1)
  })

  it('reports emptiness', () => {
    expect(new ReadOnlyValuesStore(null).isEmpty).toBe(true)
    expect(new ReadOnlyValuesStore({ a: 1 }).isEmpty).toBe(false)
  })
})

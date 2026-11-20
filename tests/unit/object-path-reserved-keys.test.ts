import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/ConfigLoader.js'
import {
  getPath,
  hasPath,
  mergeDeep,
  omitPaths,
  pickPaths,
  setPath,
} from '../../src/utils/objectPath.js'

function probe(): unknown {
  const empty: Record<string, unknown> = {}
  return empty.polluted
}

afterEach(() => {
  Reflect.deleteProperty(Object.prototype, 'polluted')
})

describe('objectPath > reserved segments never reach a prototype', () => {
  it('config.set refuses a __proto__ segment', () => {
    const config = new ConfigStore()
    config.set('__proto__.polluted', 'yes')
    expect(probe()).toBeUndefined()
    expect(config.all()).toEqual({})
  })

  it('setPath refuses constructor.prototype and a bracketed __proto__', () => {
    const target: Record<string, unknown> = {}
    setPath(target, 'constructor.prototype.polluted', 'yes')
    setPath(target, 'a[__proto__].polluted', 'yes')
    setPath(target, 'prototype', 'yes')
    expect(probe()).toBeUndefined()
    expect(target).toEqual({})
  })

  it('loadFromObject cannot pollute through a dotted key', () => {
    const config = new ConfigStore()
    config.loadFromObject({ '__proto__.polluted': 'yes', app: { name: 'x' } })
    expect(probe()).toBeUndefined()
    expect(config.get('app.name')).toBe('x')
  })

  it('readers treat the reserved names as absent', () => {
    const config = new ConfigStore()
    config.set('app.name', 'x')
    expect(config.get('__proto__', 'fallback')).toBe('fallback')
    expect(config.get('constructor', 'fallback')).toBe('fallback')
    expect(config.get('app.constructor.name', 'fallback')).toBe('fallback')
    expect(getPath({ a: {} }, 'a.__proto__')).toBeUndefined()
    expect(hasPath({ a: {} }, 'a.constructor')).toBe(false)
    expect(config.has('__proto__')).toBe(false)
  })

  it('pickPaths and omitPaths skip reserved paths', () => {
    expect(pickPaths({ a: 1 }, ['__proto__', 'constructor.name', 'a'])).toEqual({ a: 1 })
    const out = omitPaths({ a: { b: 1 } }, [
      'constructor.prototype.toString',
      '__proto__.hasOwnProperty',
    ])
    expect(out).toEqual({ a: { b: 1 } })
    expect(typeof Object.prototype.toString).toBe('function')
    expect(typeof Object.prototype.hasOwnProperty).toBe('function')
  })

  it('mergeDeep ignores an own __proto__ key of parsed JSON', () => {
    const source: unknown = JSON.parse('{"__proto__":{"polluted":"yes"},"b":2}')
    const merged = mergeDeep({ a: 1 }, source)
    expect(merged).toEqual({ a: 1, b: 2 })
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(probe()).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { compose } from '../../src/helpers/compose.js'

/**
 * `compose` means mixin composition here, the way it does in AdonisJS — and
 * that name used to be taken on the barrel by the middleware pipeline
 * composer, so `compose(BaseModel, SoftDeletes)` ported from an Adonis app
 * reached something with an entirely different meaning.
 */
describe('helpers > compose', () => {
  class Base {
    static origin = 'base'
    name(): string {
      return 'base'
    }
  }

  // Generic over the superclass, and that is what keeps this file out of the
  // typecheck: `class extends T` where `T` is a type PARAMETER is a mixin class
  // in TypeScript's eyes, and one must extend a base spelt
  // `new (...args: any[]) => …` (TS2545). The rule is hard-coded in the
  // compiler — `never[]` does not satisfy it — and `any` is banned here.
  //
  // Written non-generically it compiles and stops testing anything: each mixin
  // would return a class extending `Base` rather than the one built so far, so
  // `compose`'s whole reason for existing — threading the accumulated type
  // through the chain — is lost, and `user.createdAt` becomes a type error.
  const Timestamped = <T extends typeof Base>(superclass: T) =>
    class extends superclass {
      static stamped = true
      createdAt = '2026-08-28'
    }

  const Sluggable = <T extends typeof Base>(superclass: T) =>
    class extends superclass {
      slug(): string {
        return this.name().toLowerCase()
      }
    }

  it('applies mixins left to right, so the last one wraps the rest', () => {
    const order: string[] = []
    const a = <T>(s: T): T => {
      order.push('a')
      return s
    }
    const b = <T>(s: T): T => {
      order.push('b')
      return s
    }
    compose(Base, a, b)
    expect(order).toEqual(['a', 'b'])
  })

  it('keeps every mixin member on the composed class, statics included', () => {
    class User extends compose(Base, Timestamped, Sluggable) {
      override name(): string {
        return 'Ada'
      }
    }

    const user = new User()
    // From the base…
    expect(user.name()).toBe('Ada')
    // …from the first mixin…
    expect(user.createdAt).toBe('2026-08-28')
    // …and from the second, which can call through to the base.
    expect(user.slug()).toBe('ada')
    // Statics survive the chain in both directions — this is what the
    // overloads buy: without them the return type is the BASE class and every
    // one of these reads stops compiling.
    expect(User.origin).toBe('base')
    expect(User.stamped).toBe(true)
  })

  it('returns the superclass untouched when a mixin is a no-op', () => {
    const identity = <T>(s: T): T => s
    expect(compose(Base, identity)).toBe(Base)
  })
})

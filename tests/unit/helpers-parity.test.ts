import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import {
  defineStaticProperty,
  MessageBuilder,
  milliseconds,
  safeTiming,
  seconds,
  string,
} from '../../src/helpers/index.js'

describe('string helpers > the casings AdonisJS ships', () => {
  it('noCase, dotCase, capitalCase, sentenceCase', () => {
    expect(string.noCase('userName')).toBe('user name')
    expect(string.dotCase('userName')).toBe('user.name')
    expect(string.capitalCase('user_name')).toBe('User Name')
    expect(string.sentenceCase('userName')).toBe('User name')
  })

  it('sentence joins values the way prose does', () => {
    expect(string.sentence(['a'])).toBe('a')
    expect(string.sentence(['a', 'b'])).toBe('a and b')
    expect(string.sentence(['a', 'b', 'c'])).toBe('a, b, and c')
  })

  it('pluralize honours a count of one', () => {
    // The reason it exists next to plural(): "1 item", not "1 items".
    expect(string.pluralize('item', 1)).toBe('item')
    expect(string.pluralize('item', 3)).toBe('items')
    expect(string.pluralize('item')).toBe('items')
  })

  it('wordWrap breaks on spaces and leaves long words whole', () => {
    expect(string.wordWrap('the quick brown fox', { width: 10 })).toBe('the quick\nbrown fox')
    // Cutting an identifier or a URL mid-token is worse than an over-long line.
    expect(string.wordWrap('supercalifragilistic', { width: 5 })).toBe('supercalifragilistic')
  })

  it('justify pads to a common width', () => {
    expect(string.justify(['a', 'bb'], { width: 4 })).toEqual(['a   ', 'bb  '])
    expect(string.justify(['a'], { width: 4, align: 'right' })).toEqual(['   a'])
  })

  it('uuid returns something shaped like a v4 uuid', () => {
    expect(string.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

describe('duration helpers', () => {
  it('milliseconds round-trips a duration expression', () => {
    expect(milliseconds.parse('2h')).toBe(7_200_000)
    expect(milliseconds.parse('30 minutes')).toBe(1_800_000)
    expect(milliseconds.format(7_200_000)).toBe('2h')
    expect(milliseconds.format(7_200_000, true)).toBe('2 hours')
  })

  it('seconds keeps the AdonisJS quirk: a number is already seconds', () => {
    // `seconds.parse(7200)` is two hours, not seven seconds. A unit-less
    // STRING, on the other hand, is milliseconds.
    expect(seconds.parse(7200)).toBe(7200)
    expect(seconds.parse('2h')).toBe(7200)
  })

  it('refuses an unreadable duration rather than calling it zero', () => {
    // A mistyped TTL that silently means "expire immediately" is worse than a
    // startup failure.
    expect(() => milliseconds.parse('soon')).toThrow()
  })
})

describe('MessageBuilder', () => {
  it('round-trips a value', () => {
    const builder = new MessageBuilder()
    expect(builder.verify(builder.build({ id: 1 }))).toEqual({ id: 1 })
  })

  it('refuses a token presented for another purpose', () => {
    // A signed password-reset token must not pass as a signed email
    // verification token — the purpose travels inside the signed payload.
    const builder = new MessageBuilder()
    const token = builder.build({ id: 1 }, undefined, 'password-reset')
    expect(builder.verify(token, 'email-verification')).toBeNull()
    expect(builder.verify(token, 'password-reset')).toEqual({ id: 1 })
  })

  it('refuses an expired token', () => {
    const builder = new MessageBuilder()
    expect(builder.verify(builder.build({ id: 1 }, -1000))).toBeNull()
  })

  it('returns null rather than throwing on garbage', () => {
    // Every failure looks the same, so a caller cannot tell "tampered" from
    // "expired" and leak which it was.
    const builder = new MessageBuilder()
    expect(builder.verify('not json')).toBeNull()
    expect(builder.verify('{"nope":1}')).toBeNull()
  })
})

describe('safeTiming', () => {
  it('holds the floor so a fast path cannot be told from a slow one', async () => {
    const startedAt = performance.now()
    await safeTiming(60, async () => 'done')
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55)
  })

  it('applies the floor to a throwing path too', async () => {
    // An error that comes back faster than a success is the same leak in the
    // other direction.
    const startedAt = performance.now()
    await expect(
      safeTiming(60, async () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55)
  })

  it('returnEarly opts out', async () => {
    const startedAt = performance.now()
    await safeTiming(500, async (timing) => {
      timing.returnEarly()
      return 'done'
    })
    expect(performance.now() - startedAt).toBeLessThan(400)
  })
})

describe('defineStaticProperty', () => {
  it('gives a subclass its own copy instead of the shared one', () => {
    // A static declared on a base class is shared: without this, a subclass
    // pushing into it writes into every sibling's copy.
    // biome-ignore lint/complexity/noStaticOnlyClass: a static-only class is exactly what defineStaticProperty operates on
    class Base {
      static columns: string[] = ['id']
    }
    class Child extends Base {}
    defineStaticProperty(Child, 'columns', { initialValue: [], strategy: 'inherit' })
    Child.columns.push('email')
    expect(Child.columns).toEqual(['id', 'email'])
    expect(Base.columns).toEqual(['id'])
  })

  it('define seeds a fresh value instead of copying', () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: a static-only class is exactly what defineStaticProperty operates on
    class Base {
      static columns: string[] = ['id']
    }
    class Child extends Base {}
    defineStaticProperty(Child, 'columns', { initialValue: [], strategy: 'define' })
    expect(Child.columns).toEqual([])
  })

  it('leaves an own property alone', () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: a static-only class is exactly what defineStaticProperty operates on
    class Own {
      static columns: string[] = ['mine']
    }
    defineStaticProperty(Own, 'columns', { initialValue: [], strategy: 'define' })
    expect(Own.columns).toEqual(['mine'])
  })
})

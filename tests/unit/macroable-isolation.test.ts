/**
 * A macro belongs to the class it was declared on.
 *
 * Eight classes extend `Macroable`. Defining on the base prototype put every
 * macro on all of them: `Response.macro('json', …)` also landed on `Request`,
 * `Router` and `HttpContext`, and two subclasses declaring the same name
 * clobbered each other with no warning. AdonisJS scopes to the calling class,
 * and a migrated app relies on that.
 */
import { describe, expect, it } from 'vitest'
import { Macroable } from '../../src/utils/Macroable.js'

class Alpha extends Macroable {}
class Beta extends Macroable {}

describe('ream > Macroable isolation', () => {
  it('a macro reaches only the class it was declared on', () => {
    Alpha.macro('greet', () => 'alpha')
    const a: Record<string, unknown> = new Alpha()
    const b: Record<string, unknown> = new Beta()
    expect(typeof a.greet).toBe('function')
    expect(b.greet).toBeUndefined()
  })

  it('two classes may declare the same macro name', () => {
    Alpha.macro('label', () => 'from-alpha')
    Beta.macro('label', () => 'from-beta')
    const a: Record<string, () => string> = new Alpha()
    const b: Record<string, () => string> = new Beta()
    expect(a.label()).toBe('from-alpha')
    expect(b.label()).toBe('from-beta')
  })

  it('a getter reaches only its own class', () => {
    Alpha.getter('who', () => 'alpha')
    const a: Record<string, unknown> = new Alpha()
    const b: Record<string, unknown> = new Beta()
    expect(a.who).toBe('alpha')
    expect(b.who).toBeUndefined()
  })

  it('a singleton getter computes once per instance', () => {
    let calls = 0
    Alpha.getter(
      'once',
      () => {
        calls += 1
        return calls
      },
      true,
    )
    const a: Record<string, unknown> = new Alpha()
    expect(a.once).toBe(1)
    expect(a.once).toBe(1)
    const other: Record<string, unknown> = new Alpha()
    expect(other.once).toBe(2)
  })

  it('does not leak onto the base class', () => {
    Alpha.macro('leaky', () => 'x')
    const base: Record<string, unknown> = new Macroable()
    expect(base.leaky).toBeUndefined()
  })
})

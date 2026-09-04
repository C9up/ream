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

/**
 * Read a member a macro added at runtime.
 *
 * The instances were annotated `Record<string, unknown>`, which a class does
 * not satisfy — an index signature promises every key, and a class promises
 * only the ones it declares. Reflecting says the same thing without claiming
 * it, which is the point of the test: the member is there because `macro()`
 * put it there, not because the type says so.
 */
function member(target: object, name: string): unknown {
  return Reflect.get(target, name)
}

/** The same, called — a macro is a method. */
function callMacro(target: object, name: string): unknown {
  const fn = member(target, name)
  if (typeof fn !== 'function') {
    throw new Error(`expected a '${name}' macro on the instance`)
  }
  return fn.call(target)
}

class Alpha extends Macroable {}
class Beta extends Macroable {}

describe('ream > Macroable isolation', () => {
  it('a macro reaches only the class it was declared on', () => {
    Alpha.macro('greet', () => 'alpha')
    const a = new Alpha()
    const b = new Beta()
    expect(typeof member(a, 'greet')).toBe('function')
    expect(member(b, 'greet')).toBeUndefined()
  })

  it('two classes may declare the same macro name', () => {
    Alpha.macro('label', () => 'from-alpha')
    Beta.macro('label', () => 'from-beta')
    const a = new Alpha()
    const b = new Beta()
    expect(callMacro(a, 'label')).toBe('from-alpha')
    expect(callMacro(b, 'label')).toBe('from-beta')
  })

  it('a getter reaches only its own class', () => {
    Alpha.getter('who', () => 'alpha')
    const a = new Alpha()
    const b = new Beta()
    expect(member(a, 'who')).toBe('alpha')
    expect(member(b, 'who')).toBeUndefined()
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
    const a = new Alpha()
    expect(member(a, 'once')).toBe(1)
    expect(member(a, 'once')).toBe(1)
    const other = new Alpha()
    expect(member(other, 'once')).toBe(2)
  })

  it('does not leak onto the base class', () => {
    Alpha.macro('leaky', () => 'x')
    const base = new Macroable()
    expect(member(base, 'leaky')).toBeUndefined()
  })
})

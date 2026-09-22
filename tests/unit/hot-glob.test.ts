import { describe, expect, it } from 'vitest'
import { globMatcher, globToRegExp } from '../../src/dev/hotGlob.js'

/**
 * The boundary globs an application writes in its `package.json`.
 *
 * Hand-rolled because the alternative was two npm packages for three
 * wildcards, so the dialect is pinned here: a pattern that quietly matches
 * nothing leaves the loader with nothing to invalidate, and `ream dev` has by
 * then given up restarting in favour of a swap that never happens.
 */
describe('dev > boundary globs', () => {
  it('matches one segment with `*`', () => {
    const match = globMatcher(['app/modules/*/controllers/*.ts'])
    expect(match('app/modules/auth/controllers/LoginController.ts')).toBe(true)
    expect(match('app/modules/auth/controllers/nested/Deep.ts')).toBe(false)
    expect(match('app/modules/auth/services/Thing.ts')).toBe(false)
  })

  it('crosses segments with `**`, including none at all', () => {
    const match = globMatcher(['app/**/controllers/*.ts'])
    expect(match('app/controllers/Home.ts')).toBe(true)
    expect(match('app/modules/auth/controllers/Login.ts')).toBe(true)
  })

  it('takes the leading ./ the doctor prints', () => {
    // `ream doctor` suggests `./app/middleware/*.ts`, so a copied suggestion
    // has to work as written.
    const match = globMatcher(['./app/middleware/*.ts'])
    expect(match('app/middleware/Auth.ts')).toBe(true)
    expect(match('./app/middleware/Auth.ts')).toBe(true)
  })

  it('reads a Windows path the same way', () => {
    const match = globMatcher(['app/modules/*/controllers/*.ts'])
    expect(match('app\\modules\\auth\\controllers\\Login.ts')).toBe(true)
  })

  it('treats regular-expression syntax as literal text', () => {
    // A dot is a character, not "any character": `Home.ts` must not match
    // `HomeXts`, or a boundary would cover files nobody meant.
    expect(globToRegExp('app/Home.ts').test('app/HomeXts')).toBe(false)
    expect(globMatcher(['app/(x)+[y].ts'])('app/(x)+[y].ts')).toBe(true)
  })

  it('matches exactly one character with `?`', () => {
    const match = globMatcher(['app/v?.ts'])
    expect(match('app/v1.ts')).toBe(true)
    expect(match('app/v12.ts')).toBe(false)
  })

  it('never matches when no boundary is declared', () => {
    expect(globMatcher([])('anything.ts')).toBe(false)
  })
})

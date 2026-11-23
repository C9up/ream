import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import * as ream from '../../src/index.js'

/**
 * Symbols a module exports but no package export path reaches are invisible to
 * every consumer — `RouteResource` sat at full member parity with AdonisJS and
 * could not be imported. Nothing failed, because nothing could try.
 */
describe('public surface', () => {
  const MUST_EXPORT = [
    // Router — the resource builder `router.resource()` hands back.
    'RouteResource',
    // HTTP — the stream `response.sse()` returns, and the abort exception a
    // client disconnect raises.
    'SseStream',
    // Session — the shape flash messages and template helpers read.
    'ReadOnlyValuesStore',
    // The aggregate bag, so `errors.E_ROUTE_NOT_FOUND` works.
    'errors',
  ] as const

  for (const name of MUST_EXPORT) {
    it(`exports ${name}`, () => {
      expect(Reflect.get(ream, name)).toBeDefined()
    })
  }

  it('reaches every error class through the errors bag, none one by one', () => {
    // One way to reach a class: a second path could drift into a second
    // class, and `instanceof` would silently stop matching.
    for (const code of [
      'E_ROUTE_NOT_FOUND',
      'E_VALIDATION_ERROR',
      'E_MISSING_ENCRYPTER_KEY',
      'E_INSECURE_ENCRYPTER_KEY',
      'E_HTTP_REQUEST_ABORTED',
      'E_UNAUTHORIZED_ACCESS',
      'E_AUTHORIZATION_FAILURE',
      'E_CANNOT_LOOKUP_ROUTE',
    ]) {
      expect(Reflect.get(ream.errors, code)).toBeDefined()
      expect(Reflect.get(ream, code)).toBeUndefined()
    }
  })

  it('raises no duplicate spelling of the missing-app-key error', async () => {
    // `E_NO_APP_KEY` and the missing-key error both existed for the same
    // condition, so catching one silently missed the other.
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry)
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
      })
    const offenders = walk(new URL('../../src', import.meta.url).pathname).filter((file) =>
      readFileSync(file, 'utf8').includes('E_NO_APP_KEY'),
    )
    expect(offenders).toEqual([])
  })
})

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
    'E_HTTP_REQUEST_ABORTED',
    // Session — the shape flash messages and template helpers read.
    'ReadOnlyValuesStore',
    // Security — what a missing or too-short APP_KEY raises.
    'E_MISSING_APP_KEY',
    'E_INSECURE_APP_KEY',
    // The aggregate bag, so `errors.E_ROUTE_NOT_FOUND` works.
    'errors',
  ] as const

  for (const name of MUST_EXPORT) {
    it(`exports ${name}`, () => {
      expect(Reflect.get(ream, name)).toBeDefined()
    })
  }

  it('the errors bag holds the same classes as the flat exports', () => {
    // Two ways to reach one class: they must not drift into two classes, or
    // `instanceof` silently stops matching.
    expect(ream.errors.E_ROUTE_NOT_FOUND).toBe(ream.E_ROUTE_NOT_FOUND)
    expect(ream.errors.E_VALIDATION_ERROR).toBe(ream.E_VALIDATION_ERROR)
    expect(ream.errors.E_MISSING_APP_KEY).toBe(ream.E_MISSING_APP_KEY)
    expect(ream.errors.E_HTTP_REQUEST_ABORTED).toBe(ream.E_HTTP_REQUEST_ABORTED)
  })

  it('raises no duplicate spelling of the missing-app-key error', async () => {
    // `E_NO_APP_KEY` and `E_MISSING_APP_KEY` both existed for the same
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

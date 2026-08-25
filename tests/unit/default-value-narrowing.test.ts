/**
 * A supplied default narrows the return type.
 *
 * `param(key, defaultValue?)` was typed `string | undefined` even when a
 * default was passed, so every call site ended in `?? ''` — a fallback for a
 * branch that cannot happen. AdonisJS has the same gap, hidden: it types these
 * `any`, so nothing there ever narrows.
 *
 * The assertions below are as much about the TYPE as the value: each `const`
 * is annotated with the narrow type, so removing an overload fails `tsc` even
 * though the runtime assertions would still pass.
 */

import { describe, expect, it } from 'vitest'
import { ConfigStore, env } from '../../src/ConfigLoader.js'
import { Request } from '../../src/http/Request.js'

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    { method: 'GET', path: '/', query: '', headers, body: '' },
    { id: '42', '*': ['a', 'b'] },
  )
}

describe('Request > a default narrows the return', () => {
  it('param()', () => {
    const withDefault: string = request().param('missing', 'fallback')
    const present: string = request().param('id', 'fallback')
    const without: string | undefined = request().param('missing')

    expect(withDefault).toBe('fallback')
    expect(present).toBe('42')
    expect(without).toBeUndefined()
  })

  it('header()', () => {
    const withDefault: string = request().header('x-missing', 'fallback')
    const present: string = request({ 'x-real': 'v' }).header('x-real', 'fallback')
    const without: string | undefined = request().header('x-missing')

    expect(withDefault).toBe('fallback')
    expect(present).toBe('v')
    expect(without).toBeUndefined()
  })

  it('cookie() and encryptedCookie()', () => {
    const cookie: string = request().cookie('absent', 'fallback')
    const encrypted: string = request().encryptedCookie('absent', 'fallback')
    const without: string | null = request().cookie('absent')

    expect(cookie).toBe('fallback')
    expect(encrypted).toBe('fallback')
    expect(without).toBeNull()
  })

  it('plainCookie(), whose third argument still resolves', () => {
    const withDefault: string = request().plainCookie('absent', 'fallback')
    // The internal spelling — an explicit `undefined` default plus options —
    // keeps its nullable type.
    const explicitUndefined: string | null = request().plainCookie<string>('absent', undefined, {
      encoded: false,
    })

    expect(withDefault).toBe('fallback')
    expect(explicitUndefined).toBeNull()
  })
})

describe('ConfigStore > a default narrows the return', () => {
  it('get()', () => {
    const loader = new ConfigStore()
    loader.set('app.name', 'ream')

    const withDefault: string = loader.get<string>('app.missing', 'fallback')
    const present: string = loader.get<string>('app.name', 'fallback')
    const without: string | undefined = loader.get<string>('app.missing')

    expect(withDefault).toBe('fallback')
    expect(present).toBe('ream')
    expect(without).toBeUndefined()
  })

  it('honours a default for a path whose parent is missing entirely', () => {
    const loader = new ConfigStore()
    const value: string = loader.get<string>('deeply.nested.key', 'fallback')
    expect(value).toBe('fallback')
  })
})

describe('env() > a default narrows the return', () => {
  it('narrows when a default is supplied', () => {
    const withDefault: string = env('REAM_DEFINITELY_UNSET', 'fallback')
    const without: string | undefined = env('REAM_DEFINITELY_UNSET')

    expect(withDefault).toBe('fallback')
    expect(without).toBeUndefined()
  })
})

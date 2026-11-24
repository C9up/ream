/**
 * Unit suite for defineConfig and checkEventsConfig — the consumer-facing
 * entry points of `config/events.ts`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkEventsConfig, defineConfig, type EventsConfig } from '../../../src/events/config.js'
import EventsProvider from '../../../src/events/EventsProvider.js'

describe('events > defineConfig', () => {
  it('returns the config object unchanged (identity helper)', () => {
    const cfg: EventsConfig = { store: 'memory' }
    expect(defineConfig(cfg)).toBe(cfg)
  })
})

describe('events > configure hook', () => {
  it('ships none: `ream configure` takes a package name, so only a root ./configure is reachable', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    )
    const exportsField =
      typeof manifest === 'object' && manifest !== null
        ? Reflect.get(manifest, 'exports')
        : undefined
    const subpaths =
      typeof exportsField === 'object' && exportsField !== null ? Object.keys(exportsField) : []
    expect(subpaths).toContain('./events/provider')
    expect(
      subpaths.filter((subpath) => subpath.endsWith('/configure') && subpath !== './configure'),
    ).toEqual([])
  })
})

describe('events > checkEventsConfig', () => {
  it('accepts no config, an empty one and the in-memory store', () => {
    expect(checkEventsConfig(undefined)).toEqual({ store: 'memory' })
    expect(checkEventsConfig(undefined)).toEqual(checkEventsConfig({}))
    expect(checkEventsConfig({ store: 'memory' })).toEqual({ store: 'memory' })
  })

  it('refuses a store this build does not have, by name', () => {
    expect(() => checkEventsConfig({ store: 'redis' })).toThrow(
      expect.objectContaining({ code: 'E_EVENTS_UNSUPPORTED_STORE' }),
    )
  })

  it('refuses an option nothing honours instead of ignoring it', () => {
    expect(() => checkEventsConfig({ store: 'memory', retries: 10 })).toThrow(
      expect.objectContaining({ code: 'E_EVENTS_UNSUPPORTED_OPTION' }),
    )
  })

  it('fails the provider boot with the same error', () => {
    const provider = new EventsProvider({
      container: {
        singleton() {},
        // register() refuses the option before anything is resolved.
        resolve: <T>(): Promise<T> => Promise.reject(new Error('not resolved in this test')),
      },
      config: { get: (key: string) => (key === 'events' ? { store: 'redis' } : undefined) },
    })
    expect(() => provider.register()).toThrow(
      expect.objectContaining({ code: 'E_EVENTS_UNSUPPORTED_STORE' }),
    )
  })
})

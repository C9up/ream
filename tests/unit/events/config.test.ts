/**
 * Unit suite for defineConfig + configure() — the consumer-facing entry
 * points for wiring the event bus via the ream provider system.
 */
import { describe, expect, it, vi } from 'vitest'
import { checkEventsConfig, defineConfig, type EventsConfig } from '../../../src/events/config.js'
import { configure } from '../../../src/events/configure.js'
import EventsProvider from '../../../src/events/EventsProvider.js'
import { defined } from '../../__helpers__/defined.js'

describe('events > defineConfig', () => {
  it('returns the config object unchanged (identity helper)', () => {
    const cfg: EventsConfig = { store: 'memory' }
    expect(defineConfig(cfg)).toBe(cfg)
  })
})

describe('events > configure', () => {
  it('registers the provider import and scaffolds config/events.ts', async () => {
    const addProvider = vi.fn(async () => {})
    // Typed by the call it stands in for: an untyped `vi.fn()` records a
    // zero-length tuple, so reading `calls[0][0]` was an index past the end.
    const writeFile = vi.fn<(path: string, content: string) => Promise<void>>(async () => {})
    await configure({
      addProvider,
      addEnvVars: vi.fn(),
      writeFile,
    })
    expect(addProvider).toHaveBeenCalledWith('@c9up/ream/events/provider')
    expect(writeFile).toHaveBeenCalledTimes(1)
    const [path, content] = defined(writeFile.mock.calls[0])
    expect(path).toBe('config/events.ts')
    expect(content).toContain('defineConfig({')
    expect(content).toContain("store: 'memory'")
    // Not scaffolded: nothing reads it (see checkEventsConfig).
    expect(content).not.toContain('retries')
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

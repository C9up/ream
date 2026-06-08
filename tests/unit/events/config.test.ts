/**
 * Unit suite for defineConfig + configure() — the consumer-facing entry
 * points for wiring the event bus via the ream provider system.
 */
import { describe, expect, it, vi } from 'vitest'
import { defineConfig } from '../../../src/events/config.js'
import { configure } from '../../../src/events/configure.js'

describe('events > defineConfig', () => {
  it('returns the config object unchanged (identity helper)', () => {
    const cfg = { store: 'memory', retries: 3 }
    expect(defineConfig(cfg)).toBe(cfg)
  })
})

describe('events > configure', () => {
  it('registers the provider import and scaffolds config/events.ts', async () => {
    const addProvider = vi.fn(async () => {})
    const writeFile = vi.fn(async () => {})
    await configure({
      addProvider,
      addEnvVars: vi.fn(),
      writeFile,
    })
    expect(addProvider).toHaveBeenCalledWith('@c9up/ream/events/provider')
    expect(writeFile).toHaveBeenCalledTimes(1)
    const [path, content] = writeFile.mock.calls[0]
    expect(path).toBe('config/events.ts')
    expect(content).toContain('defineConfig({')
    expect(content).toContain("store: 'memory'")
    expect(content).toContain('retries: 3')
  })
})

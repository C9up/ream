import { describe, expect, it } from 'vitest'
import { defineConfig } from '../../src/Ignitor.js'

/**
 * `tests.japaPlugins` existed in 0.2.0 and went away in 0.2.1, when the
 * ream↔helix bridge moved to `@c9up/helix-plugin-ream`. It went away with no
 * signpost: an rc file carrying it stopped compiling and nothing said where
 * the option had gone.
 *
 * The type now names the reason (`RemovedIn_0_2_1_MovedToHelixPluginReam`),
 * which covers an object literal. This covers the rest — a value that reached
 * `defineConfig` through a variable, a spread, or plain JavaScript, where the
 * key would otherwise be accepted and silently do nothing.
 */
describe('defineConfig > removed options', () => {
  it('names the replacement when the rc file still carries japaPlugins', () => {
    // Built as a value so the excess-property check does not fire first —
    // this is the path a real rc file takes when it spreads a shared base.
    const tests: Record<string, unknown> = { japaPlugins: true }
    expect(() => defineConfig({ tests })).toThrowError(
      /E_REAMRC_REMOVED_OPTION.*helix-plugin-ream/s,
    )
  })

  it('says so even when the value is falsy — the key is what is gone', () => {
    const tests: Record<string, unknown> = { japaPlugins: false }
    expect(() => defineConfig({ tests })).toThrowError(/E_REAMRC_REMOVED_OPTION/)
  })

  it('leaves a config without it untouched', () => {
    const config = { tests: { forceExit: true, bootstrap: 'tests/boot.ts' } }
    expect(defineConfig(config)).toBe(config)
  })
})

import { describe, expect, it } from 'vitest'
import { readHotHookConfig } from '../../src/dev/hotConfig.js'

/**
 * Reading what the application declared.
 *
 * The boundaries belong to the APPLICATION, as upstream: they depend on a
 * layout the framework does not own, and a glob that reaches a statically
 * imported file costs a full reload rather than a hot swap. `ream new` writes
 * the block and `ream doctor` reports its absence; this only has to read it
 * without inventing anything.
 */
describe('hot-hook config', () => {
  it('reads what the application declared, and ignores what it cannot use', () => {
    const config = readHotHookConfig({
      hotHook: { boundaries: ['./a.ts', 42], root: './x', ignore: 'not-an-array' },
    })
    expect(config.boundaries).toEqual(['./a.ts'])
    expect(config.root).toBe('./x')
    expect(config.ignore).toBeUndefined()
  })

  it('answers an empty config for a package.json without the key', () => {
    expect(readHotHookConfig({})).toEqual({})
    expect(readHotHookConfig(null)).toEqual({})
  })
})

import { describe, expect, it } from 'vitest'
import { ReamError } from '../../src/errors/ReamError.js'
import { defineConfig } from '../../src/Ignitor.js'

/**
 * An option that was renamed, removed between versions, or mistyped used to sit
 * in the rc file doing nothing: TypeScript's excess-property check only fires
 * on an object literal, so a key arriving through a variable or a spread was
 * invisible, and the run behaved as if it had never been written.
 */
describe('defineConfig > unknown tests options', () => {
  it('names the key and lists what the block accepts', () => {
    // Built as a value so the excess-property check does not fire first — this
    // is the path a real rc file takes when it spreads a shared base.
    const tests: Record<string, unknown> = { runnerPlugins: true }
    let thrown: unknown
    try {
      defineConfig({ tests })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ReamError)
    // The code is what a caller matches on; the message names the key…
    expect((thrown as ReamError).code).toBe('E_REAMRC_UNKNOWN_OPTION')
    expect((thrown as ReamError).message).toContain('`runnerPlugins`')
    // …and the hint answers "then what IS accepted", which is also the answer
    // to "where did my option go".
    expect((thrown as ReamError).hint).toContain('bootstrap, forceExit, suites, timeout')
  })

  it('says so even when the value is falsy — the key is what is wrong', () => {
    const tests: Record<string, unknown> = { typo: false }
    expect(() => defineConfig({ tests })).toThrowError(/no option named `typo`/)
  })

  it('reports every unknown key at once, not just the first', () => {
    const tests: Record<string, unknown> = { alpha: 1, bravo: 2 }
    const run = () => defineConfig({ tests })
    expect(run).toThrowError(/`alpha`/)
    expect(run).toThrowError(/`bravo`/)
  })

  it('leaves a config built only from real options untouched', () => {
    const config = {
      tests: { forceExit: true, bootstrap: 'tests/boot.ts', timeout: 5, suites: [] },
    }
    expect(defineConfig(config)).toBe(config)
  })

  it('accepts a config with no tests block at all', () => {
    const config = { providers: [] }
    expect(defineConfig(config)).toBe(config)
  })
})

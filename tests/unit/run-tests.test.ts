import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runTests, runTestsFromRcFile, UnknownSuiteError } from '../../src/testing/runTests.js'

/**
 * `ream test` — the framework reads its rc file and hands the suites to the
 * runner, the way `@adonisjs/core` reads `adonisrc.ts` and hands them to Japa.
 * These cover the translation ream owns; the execution itself is helix's and is
 * proven there.
 */
describe('runTests', () => {
  const dirs: string[] = []
  let root: string
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV
    root = mkdtempSync(join(tmpdir(), 'ream-runtests-'))
    dirs.push(root)
  })

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    delete process.env.HELIX_BOOTSTRAP
    delete process.env.HELIX_FORCE_EXIT
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A suite with no matching file, so nothing is ever spawned. */
  const emptySuite = { name: 'unit', files: 'tests/unit/**/*.spec.ts' }

  it('sets NODE_ENV=test before anything else — what makes .env.test win', async () => {
    process.env.NODE_ENV = 'development'

    await runTests({ suites: [emptySuite] }, { root })

    expect(process.env.NODE_ENV).toBe('test')
  })

  it('names the unknown suite and lists what is declared', async () => {
    await expect(
      runTests({ suites: [emptySuite, { name: 'e2e', files: 'x' }] }, { root, suites: ['nope'] }),
    ).rejects.toThrow(UnknownSuiteError)

    await expect(
      runTests({ suites: [emptySuite] }, { root, suites: ['nope'] }),
    ).rejects.toThrow(/Declared: unit\./)
  })

  it('says so when the rc file declares no suite at all', async () => {
    await expect(runTests({ suites: [] }, { root, suites: ['nope'] })).rejects.toThrow(
      /declares none/,
    )
  })

  it('forwards the bootstrap module it resolved', async () => {
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests/bootstrap.ts'), 'export const plugins = []\n')

    await runTests({ suites: [emptySuite] }, { root })

    expect(process.env.HELIX_BOOTSTRAP).toBe(join(root, 'tests/bootstrap.ts'))
  })

  it('leaves the bootstrap unset when the project has none', async () => {
    await runTests({ suites: [emptySuite] }, { root })

    expect(process.env.HELIX_BOOTSTRAP).toBe('')
  })

  it('honours a bootstrap path declared in the rc file', async () => {
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom/boot.ts'), 'export const plugins = []\n')

    await runTests({ suites: [emptySuite], bootstrap: 'custom/boot.ts' }, { root })

    expect(process.env.HELIX_BOOTSTRAP).toBe(join(root, 'custom/boot.ts'))
  })

  it('carries tests.forceExit through to the runner', async () => {
    await runTests({ suites: [emptySuite], forceExit: true }, { root })

    expect(process.env.HELIX_FORCE_EXIT).toBe('1')
  })

  it('succeeds when every declared suite matches nothing', async () => {
    // An empty suite is a warning, not a failure — the exit code must not
    // claim tests failed when none ran.
    await expect(runTests({ suites: [emptySuite] }, { root })).resolves.toBe(0)
  })
})

describe('runTestsFromRcFile', () => {
  const dirs: string[] = []
  let root: string
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV
    root = mkdtempSync(join(tmpdir(), 'ream-runtests-rc-'))
    dirs.push(root)
  })

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    delete process.env.HELIX_BOOTSTRAP
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the tests block off the rc file default export', async () => {
    writeFileSync(
      join(root, 'reamrc.ts'),
      'export default { tests: { suites: [{ name: "unit", files: "tests/unit/**/*.spec.ts" }] } }\n',
    )

    await expect(runTestsFromRcFile('reamrc.ts', { root })).resolves.toBe(0)
    // Selecting a suite the rc file declares proves the block was read, not
    // silently defaulted away.
    await expect(runTestsFromRcFile('reamrc.ts', { root, suites: ['nope'] })).rejects.toThrow(
      /Declared: unit\./,
    )
  })

  it('treats an rc file without a tests block as no suites declared', async () => {
    writeFileSync(join(root, 'reamrc.ts'), 'export default { providers: [] }\n')

    await expect(runTestsFromRcFile('reamrc.ts', { root, suites: ['nope'] })).rejects.toThrow(
      /declares none/,
    )
  })
})

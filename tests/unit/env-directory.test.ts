import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnvFiles } from '../../src/env/loadEnvFiles.js'

/**
 * Where a BUILT application reads its `.env*` from.
 *
 * `start/env.js` resolves its app root from its own URL, which in a build
 * lands inside `dist/` — so the files at the project root became invisible and
 * `ream start` died on a `.env` it was standing next to. `ENV_PATH` is how
 * the CLI says where the project actually is, and it exists so the ORDER these
 * files are read in stays defined once, in the loader.
 */
describe('env > which directory the files come from', () => {
  const saved = { ...process.env }
  let root: string
  let built: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ream-env-root-'))
    built = mkdtempSync(join(tmpdir(), 'ream-env-dist-'))
    delete process.env.ENV_PATH
    delete process.env.FROM_ROOT
    delete process.env.FROM_BUILD
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  const dir = (path: string) => pathToFileURL(`${path}/`)

  it('reads beside the application when nothing says otherwise', () => {
    writeFileSync(join(built, '.env'), 'FROM_BUILD=yes\n')
    loadEnvFiles(dir(built))
    expect(process.env.FROM_BUILD).toBe('yes')
  })

  it('reads the directory ENV_PATH names', () => {
    writeFileSync(join(root, '.env'), 'FROM_ROOT=yes\n')
    process.env.ENV_PATH = root
    // The app root is the build output, which has no env file at all — the
    // situation `ream start` is in.
    loadEnvFiles(dir(built))
    expect(process.env.FROM_ROOT).toBe('yes')
  })

  it('takes the override over the application directory', () => {
    writeFileSync(join(built, '.env'), 'WHICH=build\n')
    writeFileSync(join(root, '.env'), 'WHICH=root\n')
    process.env.ENV_PATH = root
    loadEnvFiles(dir(built))
    expect(process.env.WHICH).toBe('root')
    delete process.env.WHICH
  })

  it('ignores an empty override rather than reading the working directory', () => {
    // An unset variable arrives as the empty string through a shell often
    // enough that treating it as "the current directory" would read whichever
    // project the terminal happened to be in.
    writeFileSync(join(built, '.env'), 'FROM_BUILD=yes\n')
    process.env.ENV_PATH = '   '
    loadEnvFiles(dir(built))
    expect(process.env.FROM_BUILD).toBe('yes')
  })

  it('takes a directory with or without its trailing slash', () => {
    writeFileSync(join(root, '.env'), 'FROM_ROOT=yes\n')
    process.env.ENV_PATH = `${root}/`
    loadEnvFiles(dir(built))
    expect(process.env.FROM_ROOT).toBe('yes')
  })

  it('refuses a directory that holds no env file at all', () => {
    // Upstream raises here, and for the reason silence would be wrong: the
    // variable is somebody saying where the file IS. A typo would otherwise
    // start the app on whatever defaults were around.
    process.env.ENV_PATH = root
    expect(() => loadEnvFiles(dir(built))).toThrow(/ENV_PATH/)
  })

  it('stays silent about a missing file when nobody named a directory', () => {
    // An application may have no env file at all, with every value coming
    // from the environment.
    expect(() => loadEnvFiles(dir(built))).not.toThrow()
  })

  it('still lets the shell win over every file', () => {
    writeFileSync(join(root, '.env'), 'WHICH=root\n')
    process.env.ENV_PATH = root
    process.env.WHICH = 'shell'
    loadEnvFiles(dir(built))
    expect(process.env.WHICH).toBe('shell')
    delete process.env.WHICH
  })
})

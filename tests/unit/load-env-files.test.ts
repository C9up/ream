import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnvFiles } from '../../src/env/loadEnvFiles.js'

/**
 * `.env` precedence — the AdonisJS rules. A test run sets `NODE_ENV=test`, so
 * `.env.test` is what makes an app talk to its test database instead of the
 * development one; getting the order wrong is the kind of bug that only shows
 * up as a wiped dev database.
 */
describe('loadEnvFiles', () => {
  const dirs: string[] = []
  const keys = ['REAM_LEF_DB', 'REAM_LEF_ONLY_BASE', 'REAM_LEF_LOCAL', 'REAM_LEF_SHELL']
  let savedNodeEnv: string | undefined

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV
    for (const key of keys) delete process.env[key]
  })

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    for (const key of keys) delete process.env[key]
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A project directory holding the given `.env*` files. */
  function project(files: Record<string, string>): URL {
    const dir = mkdtempSync(join(tmpdir(), 'ream-lef-'))
    dirs.push(dir)
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents)
    }
    return pathToFileURL(`${dir}/`)
  }

  it('loads .env.test over .env when NODE_ENV is test', () => {
    process.env.NODE_ENV = 'test'
    const root = project({
      '.env': 'REAM_LEF_DB=dev\nREAM_LEF_ONLY_BASE=base\n',
      '.env.test': 'REAM_LEF_DB=test\n',
    })

    loadEnvFiles(root, { skipEnvLocal: true })

    expect(process.env.REAM_LEF_DB).toBe('test')
    // `.env` still supplies what `.env.test` does not override.
    expect(process.env.REAM_LEF_ONLY_BASE).toBe('base')
  })

  it('leaves .env alone when NODE_ENV is not test', () => {
    process.env.NODE_ENV = 'development'
    const root = project({
      '.env': 'REAM_LEF_DB=dev\n',
      '.env.test': 'REAM_LEF_DB=test\n',
    })

    loadEnvFiles(root)

    expect(process.env.REAM_LEF_DB).toBe('dev')
  })

  it('skips .env.local for a test run, so local overrides do not leak in', () => {
    process.env.NODE_ENV = 'test'
    const root = project({
      '.env': 'REAM_LEF_LOCAL=base\n',
      '.env.local': 'REAM_LEF_LOCAL=from_local\n',
    })

    loadEnvFiles(root, { skipEnvLocal: true })

    expect(process.env.REAM_LEF_LOCAL).toBe('base')
  })

  it('reads .env.local otherwise', () => {
    process.env.NODE_ENV = 'development'
    const root = project({
      '.env': 'REAM_LEF_LOCAL=base\n',
      '.env.local': 'REAM_LEF_LOCAL=from_local\n',
    })

    loadEnvFiles(root)

    expect(process.env.REAM_LEF_LOCAL).toBe('from_local')
  })

  it('never overrides what the shell or CI already set', () => {
    process.env.NODE_ENV = 'test'
    process.env.REAM_LEF_SHELL = 'from_shell'
    const root = project({ '.env.test': 'REAM_LEF_SHELL=from_file\n' })

    loadEnvFiles(root, { skipEnvLocal: true })

    expect(process.env.REAM_LEF_SHELL).toBe('from_shell')
  })

  it('is a no-op when the project has no env files at all', () => {
    process.env.NODE_ENV = 'test'
    const root = project({})

    expect(() => loadEnvFiles(root, { skipEnvLocal: true })).not.toThrow()
  })
})

import 'reflect-metadata'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Ignitor } from '../../src/index.js'

describe('ignitor > .env auto-loading (console + web parity)', () => {
  const created: string[] = []
  const touchedKeys = ['REAM_ENV_FOO', 'REAM_ENV_BAR']

  afterEach(() => {
    for (const k of touchedKeys) delete process.env[k]
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function projectWithEnv(contents: string): URL {
    const dir = mkdtempSync(join(tmpdir(), 'ream-env-'))
    created.push(dir)
    writeFileSync(join(dir, '.env'), contents)
    return pathToFileURL(`${dir}/`)
  }

  it('loads .env into process.env when booting in console mode', async () => {
    delete process.env.REAM_ENV_FOO
    const appRoot = projectWithEnv('REAM_ENV_FOO=from_dotenv\n')
    const ig = await new Ignitor(appRoot).setEnvironment('console').start()
    expect(process.env.REAM_ENV_FOO).toBe('from_dotenv')
    await ig.stop()
  })

  it('does not override a value already present in the environment (shell wins)', async () => {
    process.env.REAM_ENV_BAR = 'from_shell'
    const appRoot = projectWithEnv('REAM_ENV_BAR=from_dotenv\n')
    const ig = await new Ignitor(appRoot).setEnvironment('console').start()
    expect(process.env.REAM_ENV_BAR).toBe('from_shell')
    await ig.stop()
  })
})

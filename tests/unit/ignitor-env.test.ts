import 'reflect-metadata'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('ignitor > APP_KEY comes from .env, like every other variable', () => {
  const created: string[] = []
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.APP_KEY
    delete process.env.APP_KEY
  })

  afterEach(() => {
    if (previousKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousKey
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function projectWithEnv(contents: string): URL {
    const dir = mkdtempSync(join(tmpdir(), 'ream-appkey-'))
    created.push(dir)
    writeFileSync(join(dir, '.env'), contents)
    return pathToFileURL(`${dir}/`)
  }

  it('registers the encryption service from a key that lives in .env', async () => {
    // A scaffolded app puts APP_KEY in .env and nowhere else. Reading it before
    // .env is loaded saw only what the shell had exported — so the signer was
    // never registered, and every signed cookie and signed URL was refused.
    const appRoot = projectWithEnv(`APP_KEY=${'k'.repeat(32)}\n`)

    const ig = await new Ignitor(appRoot).setEnvironment('console').start()

    expect(ig.getApp().container.has('encryption')).toBe(true)
    expect(ig.getApp().container.has('signedUrl')).toBe(true)
    await ig.stop()
  })

  it('signs and verifies with that key', async () => {
    const appRoot = projectWithEnv(`APP_KEY=${'k'.repeat(32)}\n`)
    const ig = await new Ignitor(appRoot).setEnvironment('console').start()

    const signer = await ig.getApp().container.resolve<{
      sign(v: unknown): string
      unsign<T>(v: string): T | null
    }>('encryption')

    expect(signer.unsign(signer.sign('hello'))).toBe('hello')
    await ig.stop()
  })

  it('still lets the shell win over .env', async () => {
    process.env.APP_KEY = 's'.repeat(32)
    const appRoot = projectWithEnv(`APP_KEY=${'k'.repeat(32)}\n`)

    const ig = await new Ignitor(appRoot).setEnvironment('console').start()

    expect(process.env.APP_KEY).toBe('s'.repeat(32))
    expect(ig.getApp().container.has('encryption')).toBe(true)
    await ig.stop()
  })

  it('registers nothing when there is no key anywhere', async () => {
    const appRoot = projectWithEnv('APP_NAME=demo\n')

    const ig = await new Ignitor(appRoot).setEnvironment('console').start()

    expect(ig.getApp().container.has('encryption')).toBe(false)
    await ig.stop()
  })
})

describe("ignitor > a keyless app does not inherit the previous one's signer", () => {
  const created: string[] = []
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.APP_KEY
    delete process.env.APP_KEY
  })

  afterEach(() => {
    if (previousKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousKey
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function projectWithEnv(contents: string): URL {
    const dir = mkdtempSync(join(tmpdir(), 'ream-inherit-'))
    created.push(dir)
    writeFileSync(join(dir, '.env'), contents)
    return pathToFileURL(`${dir}/`)
  }

  it('leaves the service locator empty for the second application', async () => {
    const { getEncryption } = await import('../../src/services/encryption.js')

    const withKey = await new Ignitor(projectWithEnv(`APP_KEY=${'k'.repeat(32)}\n`))
      .setEnvironment('console')
      .start()
    expect(getEncryption()).toBeDefined()

    // A second application boots in the same process with no key at all.
    // (`.env` loading never overrides what is already in `process.env`, so the
    // first project's key has to be taken back out to reach this case.)
    delete process.env.APP_KEY
    const without = await new Ignitor(projectWithEnv('APP_NAME=demo\n'))
      .setEnvironment('console')
      .start()

    // Inheriting would sign its cookies with a key it never configured.
    expect(getEncryption()).toBeUndefined()
    expect(without.getApp().container.has('encryption')).toBe(false)

    await without.stop()
    await withKey.stop()
  })

  it('the per-application container stays the reliable source', async () => {
    const withKey = await new Ignitor(projectWithEnv(`APP_KEY=${'k'.repeat(32)}\n`))
      .setEnvironment('console')
      .start()

    // The locator is process-global by design; the container is not.
    expect(withKey.getApp().container.has('encryption')).toBe(true)
    await withKey.stop()
  })
})

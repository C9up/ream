import 'reflect-metadata'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Ignitor } from '../../src/index.js'

describe('ignitor > config/*.ts auto-loading', () => {
  const created: string[] = []

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Build a throwaway app root holding one `config/<name>.ts` file. */
  function projectWithConfig(name: string, source: string): URL {
    const dir = mkdtempSync(join(tmpdir(), 'ream-config-'))
    created.push(dir)
    mkdirSync(join(dir, 'config'))
    writeFileSync(join(dir, 'config', `${name}.ts`), source)
    return pathToFileURL(`${dir}/`)
  }

  /** Boot the app and hand back whatever a provider reads at `key`. */
  async function readConfig(appRoot: URL, key: string): Promise<unknown> {
    let seen: unknown = 'provider never ran'
    const ig = await new Ignitor(appRoot)
      .setEnvironment('console')
      .provider((app) => ({
        register() {
          seen = app.config.get(key)
        },
      }))
      .start()
    await ig.stop()
    return seen
  }

  it('keeps a default export of `undefined` undefined, so a provider guard can see it', async () => {
    // A module that exports `undefined` is saying "I am not configured".
    // Providers gate on that with `if (!config) return`; storing the module
    // namespace instead would make the guard unreachable and boot the module
    // with no settings at all.
    const appRoot = projectWithConfig('timeseries', 'export default undefined\n')
    expect(await readConfig(appRoot, 'timeseries')).toBeUndefined()
  })

  it('stores the default export when there is one', async () => {
    const appRoot = projectWithConfig('database', 'export default { host: "127.0.0.1" }\n')
    expect(await readConfig(appRoot, 'database')).toEqual({ host: '127.0.0.1' })
  })

  it('falls back to the named exports when the module has no default', async () => {
    const appRoot = projectWithConfig('mail', 'export const from = "hi@example.com"\n')
    expect(await readConfig(appRoot, 'mail')).toEqual({ from: 'hi@example.com' })
  })

  it('stores the named-export fallback as a plain, extensible object', async () => {
    // An ESM namespace is sealed and null-prototype: kept as-is, anything that
    // later merges into this config entry would throw.
    const appRoot = projectWithConfig('cache', 'export const ttl = 60\n')
    const value = await readConfig(appRoot, 'cache')
    expect(Object.isExtensible(value)).toBe(true)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  })
})

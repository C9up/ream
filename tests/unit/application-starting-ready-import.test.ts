/**
 * `app.starting()` / `app.ready()` hooks and `app.import()` /
 * `app.importDefault()` through the application's importer — the
 * `@adonisjs/application` surface a package written for it relies on.
 */

import 'reflect-metadata'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Application } from '../../src/Application.js'
import { Ignitor } from '../../src/Ignitor.js'

const ignitors: Ignitor[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ignitor of ignitors.splice(0)) await ignitor.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Application > starting and ready hooks', () => {
  it('runs starting after the providers start and before the preloads, ready after the providers are ready', async () => {
    const order: string[] = []
    const ignitor = new Ignitor()
    ignitors.push(ignitor)
    const app = ignitor.getApp()

    ignitor.provider(() => ({
      start: () => {
        order.push('provider.start')
      },
      ready: () => {
        order.push('provider.ready')
      },
    }))
    ignitor.useRcFile({
      preloads: [
        async () => {
          order.push('preload')
        },
      ],
    })
    const chained = app.starting((received) => {
      expect(received).toBe(app)
      order.push('starting')
    })
    expect(chained).toBe(app)
    await app.ready((received) => {
      expect(received).toBe(app)
      // As upstream: the hooks run before the state flips to ready.
      expect(received.isReady).toBe(false)
      order.push('ready')
    })

    await ignitor.start()

    expect(order).toEqual(['provider.start', 'starting', 'preload', 'provider.ready', 'ready'])
    expect(app.isReady).toBe(true)
  })

  it('runs a ready hook at once when the application is already ready', async () => {
    const ignitor = new Ignitor()
    ignitors.push(ignitor)
    await ignitor.start()
    const app = ignitor.getApp()

    let received: Application | undefined
    await app.ready(async (ready) => {
      received = ready
    })
    expect(received).toBe(app)
  })

  it('runs the starting hooks during a warm-up too, and the ready hooks never', async () => {
    const order: string[] = []
    const ignitor = new Ignitor()
    ignitors.push(ignitor)
    const app = ignitor.getApp()
    app.starting(() => {
      order.push('starting')
    })
    await app.ready(() => {
      order.push('ready')
    })
    await ignitor.warmUp()
    expect(order).toEqual(['starting'])
  })

  it('fails the start when a ready hook throws', async () => {
    const ignitor = new Ignitor()
    ignitors.push(ignitor)
    await ignitor.getApp().ready(() => {
      throw new Error('warm cache failed')
    })
    await expect(ignitor.start()).rejects.toThrow('warm cache failed')
  })
})

describe('Application > import through the importer', () => {
  function appDirectory(): URL {
    const dir = mkdtempSync(join(tmpdir(), 'ream-app-import-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'app', 'listeners'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ type: 'module', imports: { '#listeners/*': './app/listeners/*.js' } }),
    )
    writeFileSync(
      join(dir, 'app', 'listeners', 'send_email.js'),
      "export default class SendEmail {}\nexport const kind = 'listener'\n",
    )
    writeFileSync(join(dir, 'app', 'listeners', 'named_only.js'), 'export const only = 1\n')
    // The importer lives IN the app, as `bin/server.ts` defines it: that is
    // what makes a `#` subpath resolve against the app's package.json.
    writeFileSync(join(dir, 'importer.js'), 'export const importer = (id) => import(id)\n')
    return pathToFileURL(`${dir}/`)
  }

  async function appImporter(root: URL): Promise<(id: string) => Promise<unknown>> {
    const module: { importer: (id: string) => Promise<unknown> } = await import(
      new URL('importer.js', root).href
    )
    return module.importer
  }

  it('resolves a # subpath from the application, not from the framework', async () => {
    const root = appDirectory()
    const ignitor = new Ignitor(root, { importer: await appImporter(root) })
    const app = ignitor.getApp()

    const module = await app.import('#listeners/send_email')
    expect(module).toMatchObject({ kind: 'listener' })
    const SendEmail = await app.importDefault<new () => object>('#listeners/send_email')
    expect(SendEmail.name).toBe('SendEmail')
  })

  it('names the module that has no default export', async () => {
    const root = appDirectory()
    const app = new Application({ importer: await appImporter(root) })
    await expect(app.importDefault('#listeners/named_only')).rejects.toMatchObject({
      code: 'E_APP_MISSING_DEFAULT_EXPORT',
      message: expect.stringMatching(/#listeners\/named_only/),
    })
  })

  it('refuses to import without an importer', () => {
    const app = new Application()
    expect(() => app.import('#listeners/send_email')).toThrow(
      expect.objectContaining({ code: 'E_APP_MISSING_IMPORTER' }),
    )
    expect(() => app.importDefault('#listeners/send_email')).toThrow(
      expect.objectContaining({ code: 'E_APP_MISSING_IMPORTER' }),
    )
  })

  it('keeps the thunk form of importDefault', async () => {
    const app = new Application()
    const value = await app.importDefault(async () => ({ default: 42 }), 'inline')
    expect(value).toBe(42)
  })
})

import 'reflect-metadata'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ignitor } from '../../src/index.js'

/**
 * `modules.autoload` decides what gets IMPORTED, and importing is what
 * registers a decorator. A `@Schedule()` in a file nobody imports is never
 * discovered and the application starts perfectly — so an entry that quietly
 * matches nothing is the worst shape this can fail in.
 */
describe('ignitor > modules.autoload', () => {
  const created: string[] = []
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** An app with one module, and files written where the test wants them. */
  function app(files: Record<string, string>): URL {
    const root = mkdtempSync(join(tmpdir(), 'ream-modules-'))
    created.push(root)
    for (const [relative, source] of Object.entries(files)) {
      const full = join(root, relative)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, source)
    }
    return pathToFileURL(`${root}/`)
  }

  /** A module file that records the fact it was imported. */
  const marker = (name: string) =>
    `globalThis.__autoloaded ??= []; globalThis.__autoloaded.push(${JSON.stringify(name)});\n`

  function loaded(): string[] {
    return ((globalThis as { __autoloaded?: string[] }).__autoloaded ?? []).slice()
  }

  async function boot(appRoot: URL, autoload: string[]): Promise<void> {
    ;(globalThis as { __autoloaded?: string[] }).__autoloaded = []
    const ignitor = await new Ignitor(appRoot)
      .setEnvironment('console')
      .useRcFile({ modules: { path: 'app/modules', autoload } })
      .start()
    await ignitor.stop()
  }

  it('loads a named FILE, as it always did', async () => {
    const root = app({ 'app/modules/billing/routes.js': marker('routes') })
    await boot(root, ['routes'])
    expect(loaded()).toEqual(['routes'])
  })

  it('loads every module file in a named DIRECTORY', async () => {
    // What `services` reads as, and what it used to do: nothing at all.
    const root = app({
      'app/modules/billing/services/Daily.js': marker('Daily'),
      'app/modules/billing/services/Weekly.js': marker('Weekly'),
      'app/modules/billing/services/nested/Deep.js': marker('Deep'),
    })
    await boot(root, ['services/'])
    // One alphabetical pass over files and directories alike, so `nested/`
    // falls between `Daily.js` and `Weekly.js`. One rule rather than two, and
    // the same order on every machine instead of whatever readdir returns.
    expect(loaded()).toEqual(['Daily', 'Deep', 'Weekly'])
  })

  it('skips a .d.ts, which declares types and executes nothing', async () => {
    const root = app({
      'app/modules/billing/services/Daily.js': marker('Daily'),
      'app/modules/billing/services/types.d.ts': 'export type X = 1\n',
      'app/modules/billing/services/README.md': 'not code\n',
    })
    await boot(root, ['services/'])
    expect(loaded()).toEqual(['Daily'])
  })

  it('reports an entry that matches nothing in any module', async () => {
    // The whole point: a name that exists nowhere used to be a no-op, and the
    // symptom appeared much later as a task that never ran.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = app({ 'app/modules/billing/routes.js': marker('routes') })
    await boot(root, ['routes', 'sevices/'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('"sevices/"')
  })

  it('stays quiet when one module simply has no routes', async () => {
    // Normal, and not worth a warning: the entry matched somewhere.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = app({
      'app/modules/billing/routes.js': marker('billing'),
      'app/modules/users/events.js': marker('users'),
    })
    await boot(root, ['routes', 'events'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('REGRESSION: the default list must not start walking a routes/ directory', async () => {
    // 0.2.19 loaded nothing here. If 0.2.20 imports these, an application that
    // never opted in suddenly executes files it never executed before.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = app({
      'app/modules/billing/routes/admin.js': marker('routes/admin'),
      'app/modules/billing/routes/public.js': marker('routes/public'),
    })
    await boot(root, ['routes', 'events'])
    expect(loaded()).toEqual([])
    void warn
  })
})

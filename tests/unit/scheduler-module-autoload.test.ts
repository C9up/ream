import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * What actually has to be true for a `@Schedule` in `app/modules/**` to fire.
 *
 * Discovery walks the IoC service registry, so a class the process never
 * imported is not there to be found — no error, no warning, just
 * "No scheduled tasks registered". Two conditions gate the import, and both are
 * easy to miss:
 *
 *   1. `reamrc.modules.path` must be set. Without it `#autoloadModules()`
 *      returns immediately and NOTHING under `app/modules/` is loaded.
 *   2. `reamrc.modules.autoload` must name the file. It defaults to
 *      `['routes', 'events']`, so `billing/price_scheduler.ts` is skipped.
 *
 * These two tests differ only in the autoload list, which is what isolates the
 * cause from every other reason a task might be missing.
 */

const APP_ROOT = new URL('../', import.meta.url)
const MODULES = './__fixtures__/scheduler-modules'

interface Booted {
  taskNames: () => string[]
  stop: () => Promise<void>
}

/**
 * Boot with a fresh module graph.
 *
 * The service registry is a module-level map filled by `@Service()` at import
 * time, so a fixture one test imported stays registered for the next — the
 * negative cases pass for the wrong reason unless the graph is rebuilt. Which
 * is also the mechanism under test: a decorator only reaches the registry when
 * something imports the file.
 */
async function boot(modules: Record<string, unknown> | undefined): Promise<Booted> {
  vi.resetModules()
  const { Ignitor } = await import('../../src/index.js')
  const { ScheduleProvider } = await import('../../src/scheduler/ScheduleProvider.js')

  let provider: InstanceType<typeof ScheduleProvider> | undefined
  const ignitor = new Ignitor(APP_ROOT, { gracefulShutdown: false })
    .provider((app) => {
      provider = new ScheduleProvider(app)
      return provider
    })
    .useRcFile(modules === undefined ? {} : { modules })
  await ignitor.start()
  return {
    taskNames: () => (provider?.scheduler.listTasks() ?? []).map((t) => t.name),
    stop: () => ignitor.stop().then(() => undefined),
  }
}

let running: Booted | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

describe('scheduler > a @Schedule declared in app/modules', () => {
  it('is found when autoload names its file', async () => {
    running = await boot({ path: MODULES, autoload: ['price_scheduler'] })
    expect(running.taskNames()).toContain('PriceScheduler.refreshPrices')
  })

  it('is invisible under the default autoload list', async () => {
    // `['routes', 'events']`. The module directory IS scanned — its routes.ts
    // is imported — so the task is missing for one reason only: nothing ever
    // imported the file that declares it.
    running = await boot({ path: MODULES })
    expect(running.taskNames()).toEqual([])
  })

  it('is invisible when modules.path is absent, whatever autoload says', async () => {
    running = await boot(undefined)
    expect(running.taskNames()).toEqual([])
  })
})

describe('scheduler > schedule:list explains an empty list', () => {
  it('names the missing modules.path', async () => {
    const { Application } = await import('../../src/Application.js')
    const app = new Application()
    app.setAppRoot(APP_ROOT)
    app.rcContents({})
    const lines = await listOutputFor(app)
    expect(lines.join('\n')).toContain('no `modules.path`')
  })

  it('names the autoload list that skipped the file', async () => {
    const { Application } = await import('../../src/Application.js')
    const app = new Application()
    app.setAppRoot(APP_ROOT)
    app.rcContents({ modules: { path: MODULES } })
    const lines = await listOutputFor(app)
    // The default list, quoted back so the reader can see what was searched.
    expect(lines.join('\n')).toContain("['routes', 'events']")
  })
})

/** Run `schedule:list` against an empty scheduler and collect what it printed. */
async function listOutputFor(app: {
  container: { singleton: (token: string, factory: () => unknown) => unknown }
}): Promise<string[]> {
  const { default: ScheduleList } = await import('../../src/commands/ScheduleList.js')
  const { Scheduler } = await import('../../src/scheduler/Scheduler.js')
  const scheduler = new Scheduler()
  app.container.singleton('scheduler', () => scheduler)

  const lines: string[] = []
  const command = new ScheduleList()
  Reflect.set(command, 'app', app)
  Reflect.set(command, 'logger', {
    info: (m: string) => lines.push(m),
    log: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  })
  await command.run()
  return lines
}

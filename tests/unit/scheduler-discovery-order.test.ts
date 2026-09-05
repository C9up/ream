import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { Service } from '../../src/decorators/Service.js'
import { Ignitor } from '../../src/index.js'
import { Schedule } from '../../src/scheduler/Schedule.js'
import { ScheduleProvider } from '../../src/scheduler/ScheduleProvider.js'

/**
 * When the scheduler reads the service registry.
 *
 * `app/modules/**` is auto-loaded at the END of the start phase, after every
 * provider's `start()`. A `@Service()` carrying `@Schedule` — which is where
 * one naturally lives — was therefore registered after the scheduler had
 * already read the registry, and the task never fired. Silently: the
 * application started normally and nothing reported a missing task.
 */

let running: Ignitor | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

describe('scheduler > discovery order', () => {
  it('finds a task a module declared after every provider started', async () => {
    let provider: ScheduleProvider | undefined

    running = new Ignitor({ gracefulShutdown: false })
      .provider((app) => {
        provider = new ScheduleProvider(app)
        // Nothing is scheduled yet — no module has been loaded.
        expect(provider.scheduler.listTasks()).toEqual([])
        return provider
      })
      // A preload runs AFTER every provider's start(), the same side of the
      // phase boundary as the module autoload. Declaring the service there
      // reproduces what `app/modules/**` does.
      .useRcFile({
        preloads: [
          async () => {
            @Service()
            class LateModuleJobs {
              @Schedule('* * * * *')
              sync(): void {}
            }
            // Referenced so the class is not treated as unused.
            expect(LateModuleJobs.name).toBe('LateModuleJobs')
          },
        ],
      })

    await running.start()

    expect(provider?.scheduler.listTasks().map((task) => task.name)).toContain(
      'LateModuleJobs.sync',
    )
  })
})

describe('ignitor > a test process serves HTTP without calling itself web', () => {
  it('binds a server in test mode, so `environment` can exclude providers', async () => {
    // The declarative way to keep a scheduled task out of a test run is the one
    // AdonisJS uses: `{ file: …, environment: ['web'] }` on the provider entry.
    // It excluded nothing, because a test bootstrap had to call `httpServer()`
    // to get a server at all — and that set the environment to 'web'. The
    // ticker then fired in the middle of the suite.
    const started: string[] = []

    class WebOnlyProvider {
      async start(): Promise<void> {
        started.push('web-only')
      }
    }
    class EverywhereProvider {
      async start(): Promise<void> {
        started.push('everywhere')
      }
    }

    let builtOnPort: number | undefined
    const app = await new Ignitor({
      serverFactory: (port) => {
        builtOnPort = port
        return {
          onRequest: () => {},
          listen: async () => {},
          port: async () => port,
          close: async () => {},
        }
      },
      port: 34519,
      gracefulShutdown: false,
    })
      .testMode()
      .useRcFile({
        providers: [
          { file: async () => ({ default: WebOnlyProvider }), environment: ['web'] },
          { file: async () => ({ default: EverywhereProvider }) },
        ],
      })
      .start()

    // A server was really built, on the port the harness asked for.
    expect(builtOnPort).toBe(34519)
    expect(await app.port()).toBe(34519)
    // And the web-scoped provider stayed out of the run.
    expect(started).toEqual(['everywhere'])
    await app.stop()
  })

  it('still builds no server for a test process that asked for none', async () => {
    const app = await new Ignitor({ gracefulShutdown: false }).testMode().start()
    expect(await app.port()).toBe(0)
    await app.stop()
  })
})

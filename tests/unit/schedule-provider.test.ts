import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppContext, ScheduleInvocation, Scheduler, TaskInfo } from '../../src/index.js'
import {
  Container,
  clearServiceRegistry,
  Scheduler as RealScheduler,
  ReamError,
  Schedule,
  ScheduleProvider,
  Service,
} from '../../src/index.js'
import { defined } from '../__helpers__/defined.js'

/**
 * Minimal `Scheduler`-shaped mock. Implements only the methods the
 * provider calls; records invocations so tests can inspect them.
 */
class MockScheduler {
  registrations: Array<{
    name: string
    cronExpr: string
    callback: (payload: ScheduleInvocation) => void | Promise<void>
  }> = []
  unregistrations: string[] = []
  started = 0
  stopped = 0
  /** When set, `register` throws this instead of recording. */
  registerError: ReamError | null = null
  /** When set, register throws *only* at this index (0-based). */
  registerErrorAtIndex: number | null = null

  register(
    name: string,
    cronExpr: string,
    callback: (payload: ScheduleInvocation) => void | Promise<void>,
  ): void {
    if (this.registerError && this.registerErrorAtIndex === null) throw this.registerError
    if (
      this.registerError &&
      this.registerErrorAtIndex !== null &&
      this.registrations.length === this.registerErrorAtIndex
    ) {
      throw this.registerError
    }
    this.registrations.push({ name, cronExpr, callback })
  }
  unregister(name: string): void {
    this.unregistrations.push(name)
  }
  start(): void {
    this.started++
  }
  stop(): void {
    this.stopped++
  }
  nextRun(_name: string): number | null {
    return null
  }
  listTasks(): TaskInfo[] {
    return []
  }
}

function buildApp(container: Container): AppContext {
  const config = {
    get: () => undefined,
    set: () => {},
  }
  return { container, config }
}

describe('ScheduleProvider > discovery + registration', () => {
  beforeEach(() => {
    clearServiceRegistry()
  })

  it('registers one task per @Schedule entry with ClassName.methodName naming', async () => {
    @Service()
    class Cleanup {
      @Schedule('*/5 * * * *')
      purgeTmp() {}

      @Schedule('0 3 * * *')
      purgeArchive() {}
    }
    expect(Cleanup).toBeDefined()

    const container = new Container()
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(container), {
      scheduler: scheduler as unknown as Scheduler,
    })

    await provider.boot()

    const names = scheduler.registrations.map((r) => r.name).sort()
    expect(names).toEqual(['Cleanup.purgeArchive', 'Cleanup.purgeTmp'])

    const byName = new Map(scheduler.registrations.map((r) => [r.name, r.cronExpr]))
    expect(byName.get('Cleanup.purgeTmp')).toBe('*/5 * * * *')
    expect(byName.get('Cleanup.purgeArchive')).toBe('0 3 * * *')
  })

  it('resolves the service via container.make on EACH invocation, not at registration', async () => {
    const constructions: string[] = []

    @Service({ scope: 'transient' })
    class Job {
      id: number
      constructor() {
        constructions.push(`built-${Date.now()}-${constructions.length}`)
        this.id = constructions.length
      }
      @Schedule('*/1 * * * *')
      async run() {}
    }

    const container = new Container()
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(container), {
      scheduler: scheduler as unknown as Scheduler,
    })

    const makeSpy = vi.spyOn(container, 'make')
    await provider.boot()
    expect(makeSpy).not.toHaveBeenCalled()
    expect(constructions).toHaveLength(0)

    const callback = scheduler.registrations[0]?.callback
    expect(callback).toBeDefined()
    await callback?.({ taskName: 'Job.run', scheduledForMs: 0 })
    await callback?.({ taskName: 'Job.run', scheduledForMs: 1 })
    expect(makeSpy).toHaveBeenCalledTimes(2)
    expect(makeSpy).toHaveBeenCalledWith(Job)
  })

  it('wraps INVALID_CRON failures from Scheduler.register into E_SCHEDULE_INVALID_CRON', async () => {
    @Service()
    class Broken {
      @Schedule('not a real cron')
      run() {}
    }
    expect(Broken).toBeDefined()

    const container = new Container()
    const scheduler = new MockScheduler()
    scheduler.registerError = new ReamError('INVALID_CRON', 'Expected 5 fields, got 4', {
      hint: 'Standard cron format has 5 fields',
      context: { expression: 'not a real cron' },
    })
    const provider = new ScheduleProvider(buildApp(container), {
      scheduler: scheduler as unknown as Scheduler,
    })

    await expect(provider.boot()).rejects.toMatchObject({
      code: 'E_SCHEDULE_INVALID_CRON',
      context: expect.objectContaining({
        task: 'Broken.run',
        cronExpr: 'not a real cron',
      }),
    })
  })

  it('ready() forwards to scheduler.start, and start() does not', async () => {
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(new Container()), {
      scheduler: scheduler as unknown as Scheduler,
    })

    // The ticker waits for ready(): `app/modules/**` is auto-loaded at the end
    // of the start phase, so a task declared there is not in the registry yet.
    await provider.start()
    expect(scheduler.started).toBe(0)

    await provider.ready()
    expect(scheduler.started).toBe(1)
  })

  it('shutdown() calls scheduler.stop', async () => {
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(new Container()), {
      scheduler: scheduler as unknown as Scheduler,
    })

    await provider.shutdown()
    expect(scheduler.stopped).toBe(1)
  })

  it('throwing scheduled method is swallowed by the real Scheduler wrapper, not leaked out', async () => {
    // Per spec Task 7.2 subcase 5: register a service whose method
    // throws; invoke the stored callback; assert no exception
    // propagates. We exercise the REAL Scheduler wrapper (which is
    // where the swallow contract lives) by injecting a fake native
    // module so no `.node` binary is required.

    @Service()
    class Flaky {
      @Schedule('*/1 * * * *')
      async boom() {
        throw new Error('task failure')
      }
    }
    expect(Flaky).toBeDefined()

    const nativeRegistrations: Array<(payload: ScheduleInvocation) => Promise<void>> = []
    const fakeNative = {
      RustScheduler: class {
        register(_name: string, _cron: string, cb: (p: ScheduleInvocation) => Promise<void>) {
          nativeRegistrations.push(cb)
        }
        unregister() {}
        start() {}
        stop() {}
        nextRun() {
          return null
        }
      },
    }

    const realScheduler = new RealScheduler({
      nativeModule: fakeNative as unknown as NonNullable<
        ConstructorParameters<typeof RealScheduler>[0]
      >['nativeModule'],
    })
    const container = new Container()
    const provider = new ScheduleProvider(buildApp(container), { scheduler: realScheduler })
    await provider.boot()

    // The callback captured by the native side is the Scheduler's
    // swallow-wrapped adapter, not the provider's raw callback.
    const capturedCallback = nativeRegistrations[0]
    expect(capturedCallback).toBeDefined()

    // Invoking it must resolve without throwing even though the
    // underlying method throws.
    await expect(
      capturedCallback?.({ taskName: 'Flaky.boom', scheduledForMs: 0 }),
    ).resolves.toBeUndefined()
  })

  it('skips classes without any @Schedule metadata', async () => {
    @Service()
    class Plain {
      doStuff() {}
    }

    const container = new Container()
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(container), {
      scheduler: scheduler as unknown as Scheduler,
    })
    await provider.boot()
    expect(scheduler.registrations).toHaveLength(0)
    expect(Plain).toBeDefined()
  })

  it('boot() is idempotent — second call does not re-register', async () => {
    @Service()
    class Once {
      @Schedule('*/5 * * * *')
      run() {}
    }
    expect(Once).toBeDefined()

    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(new Container()), {
      scheduler: scheduler as unknown as Scheduler,
    })

    await provider.boot()
    expect(scheduler.registrations).toHaveLength(1)
    await provider.boot()
    expect(scheduler.registrations).toHaveLength(1)
  })

  it('rolls back partially-registered tasks when a later register fails', async () => {
    @Service()
    class Mixed {
      @Schedule('*/5 * * * *')
      first() {}

      @Schedule('*/10 * * * *')
      second() {}

      @Schedule('bad cron')
      third() {}
    }
    expect(Mixed).toBeDefined()

    const scheduler = new MockScheduler()
    // Fail only on the third register call.
    scheduler.registerError = new ReamError('INVALID_CRON', 'Expected 5 fields, got 2')
    scheduler.registerErrorAtIndex = 2

    const provider = new ScheduleProvider(buildApp(new Container()), {
      scheduler: scheduler as unknown as Scheduler,
    })

    await expect(provider.boot()).rejects.toMatchObject({ code: 'E_SCHEDULE_INVALID_CRON' })

    // The first two registrations must have been rolled back.
    expect(scheduler.unregistrations.sort()).toEqual(['Mixed.first', 'Mixed.second'].sort())
  })

  it('rejects anonymous classes with E_SCHEDULE_ANONYMOUS_CLASS', async () => {
    // Build a truly nameless class. Modern JS infers `.name` from the
    // const binding, so we override it explicitly to simulate the
    // `export default class { ... }` / IIFE cases where the name is
    // empty.
    const Anon = class {
      run() {}
    }
    Object.defineProperty(Anon, 'name', { value: '' })
    expect(Anon.name).toBe('')

    clearServiceRegistry()
    Schedule('*/5 * * * *')(
      Anon.prototype,
      'run',
      defined(Object.getOwnPropertyDescriptor(Anon.prototype, 'run')),
    )
    Service()(Anon as unknown as new () => object)

    const provider = new ScheduleProvider(buildApp(new Container()), {
      scheduler: new MockScheduler() as unknown as Scheduler,
    })

    await expect(provider.boot()).rejects.toMatchObject({
      code: 'E_SCHEDULE_ANONYMOUS_CLASS',
    })
  })

  it('register() binds the scheduler into the container under token "scheduler"', async () => {
    const container = new Container()
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(container), {
      scheduler: scheduler as unknown as Scheduler,
    })
    provider.register()
    const resolved = await container.resolve<unknown>('scheduler')
    // The container returns the exact scheduler instance the provider holds.
    expect(resolved).toBe(provider.scheduler)
  })

  it('register() is idempotent when the same provider re-runs phase 1', async () => {
    const container = new Container()
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(buildApp(container), {
      scheduler: scheduler as unknown as Scheduler,
    })
    provider.register()
    expect(() => provider.register()).not.toThrow()
    expect(await container.resolve<unknown>('scheduler')).toBe(provider.scheduler)
  })

  it('register() throws E_SCHEDULE_PROVIDER_ALREADY_REGISTERED when a different provider claimed the token first', () => {
    const container = new Container()
    const providerA = new ScheduleProvider(buildApp(container), {
      scheduler: new MockScheduler() as unknown as Scheduler,
    })
    const providerB = new ScheduleProvider(buildApp(container), {
      scheduler: new MockScheduler() as unknown as Scheduler,
    })
    providerA.register()
    expect(() => providerB.register()).toThrow(
      expect.objectContaining({ code: 'E_SCHEDULE_PROVIDER_ALREADY_REGISTERED' }),
    )
  })

  it('rejects symbol-keyed methods with E_SCHEDULE_SYMBOL_METHOD', async () => {
    const runKey = Symbol('run')
    @Service()
    class SymbolMethod {
      [runKey]() {}
    }
    // Apply @Schedule programmatically since decorator syntax on
    // computed keys is not supported in all TS configs.
    Schedule('*/5 * * * *')(
      SymbolMethod.prototype,
      runKey,
      defined(Object.getOwnPropertyDescriptor(SymbolMethod.prototype, runKey)),
    )

    const provider = new ScheduleProvider(buildApp(new Container()), {
      scheduler: new MockScheduler() as unknown as Scheduler,
    })

    await expect(provider.boot()).rejects.toMatchObject({
      code: 'E_SCHEDULE_SYMBOL_METHOD',
    })
  })
})

describe('ScheduleProvider > a task declared after boot', () => {
  beforeEach(() => {
    clearServiceRegistry()
  })

  it('is discovered at start, which is when app/modules is loaded', async () => {
    const container = new Container()
    const app = buildApp(container)
    const scheduler = new MockScheduler()
    const provider = new ScheduleProvider(app, {
      scheduler: scheduler as unknown as Scheduler,
    })

    provider.register()
    await provider.boot()
    expect(scheduler.registrations).toHaveLength(0)

    // What `#autoloadModules()` does during the start phase: importing a
    // module file registers its @Service classes. Before this fix the
    // scheduler had already read the registry and never looked again — the
    // task simply never fired, with nothing said about it.
    @Service()
    class Reports {
      @Schedule('* * * * *')
      async nightly() {}
    }
    void Reports

    await provider.start()

    expect(scheduler.registrations.map((r) => r.name)).toEqual(['Reports.nightly'])
  })

  it('does not register a task twice across the two passes', async () => {
    const container = new Container()
    const app = buildApp(container)
    const scheduler = new MockScheduler()

    @Service()
    class Billing {
      @Schedule('0 3 * * *')
      async invoice() {}
    }
    void Billing

    const provider = new ScheduleProvider(app, {
      scheduler: scheduler as unknown as Scheduler,
    })
    provider.register()
    await provider.boot()
    await provider.start()

    // Both phases walk the registry; a task already registered is skipped
    // rather than fired twice per tick.
    expect(scheduler.registrations).toHaveLength(1)
  })
})

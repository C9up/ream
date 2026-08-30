import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import type { AppContext, LockBackend, SchedulerConfig } from '../../src/index.js'
import { Container, MemoryLockBackend, ScheduleProvider, Scheduler } from '../../src/index.js'

/** An app whose config store answers only for `scheduler`. */
function buildApp(scheduler?: SchedulerConfig): AppContext {
  return {
    container: new Container(),
    config: {
      get: (key: string) => (key === 'scheduler' ? scheduler : undefined),
      set: () => {},
    },
  } as unknown as AppContext
}

describe('ScheduleProvider > config/scheduler.ts', () => {
  it('builds the lock the config names', () => {
    const built = vi.fn(() => new MemoryLockBackend())

    new ScheduleProvider(buildApp({ lock: built }))

    // The config file cannot build it itself — it is read before the
    // connection a Redis lock needs exists — so the provider calls the
    // factory, once.
    expect(built).toHaveBeenCalledTimes(1)
  })

  it('takes a backend given directly', () => {
    const backend: LockBackend = {
      acquire: async () => true,
      release: async () => {},
    }

    expect(() => new ScheduleProvider(buildApp({ lock: backend }))).not.toThrow()
  })

  it('runs unlocked when nothing is configured', () => {
    const provider = new ScheduleProvider(buildApp())

    expect(provider.scheduler).toBeInstanceOf(Scheduler)
  })

  it('leaves an injected scheduler alone, config or not', () => {
    const built = vi.fn(() => new MemoryLockBackend())
    const injected = new Scheduler()

    const provider = new ScheduleProvider(buildApp({ lock: built }), { scheduler: injected })

    expect(provider.scheduler).toBe(injected)
    expect(built).not.toHaveBeenCalled()
  })
})

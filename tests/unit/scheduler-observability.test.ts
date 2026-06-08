import { describe, expect, it, vi } from 'vitest'
import type {
  ErrorReporter,
  LockBackend,
  ScheduleEvent,
  ScheduleEventSink,
  ScheduleInvocation,
  SchedulerOptions,
} from '../../src/index.js'
import { MemoryLockBackend, Scheduler } from '../../src/index.js'

function buildNative(): NonNullable<SchedulerOptions['nativeModule']> {
  return {
    RustScheduler: class {
      register() {}
      unregister() {}
      start() {}
      stop() {}
      nextRun() {
        return null
      }
    },
  } as unknown as NonNullable<SchedulerOptions['nativeModule']>
}

/**
 * Build a Scheduler + capture the native callback list.
 */
function build(
  opts: {
    lockBackend?: LockBackend
    eventSink?: ScheduleEventSink
    errorReporter?: ErrorReporter
  } = {},
) {
  const registrations: Array<{
    name: string
    cronExpr: string
    callback: (p: ScheduleInvocation) => Promise<void>
  }> = []
  const native = {
    RustScheduler: class {
      register(name: string, cronExpr: string, cb: (p: ScheduleInvocation) => Promise<void>) {
        registrations.push({ name, cronExpr, callback: cb })
      }
      unregister() {}
      start() {}
      stop() {}
      nextRun() {
        return null
      }
    },
  } as unknown as NonNullable<SchedulerOptions['nativeModule']>
  const scheduler = new Scheduler({
    nativeModule: native,
    lockBackend: opts.lockBackend,
    eventSink: opts.eventSink,
    errorReporter: opts.errorReporter,
  })
  return { scheduler, registrations }
}

function makeSink() {
  const events: ScheduleEvent[] = []
  const sink: ScheduleEventSink = {
    emit(e) {
      events.push(e)
    },
  }
  return { events, sink }
}

describe('Scheduler observability', () => {
  it('emits started then completed for a synchronous-success task', async () => {
    const { events, sink } = makeSink()
    const { scheduler, registrations } = build({ eventSink: sink })
    scheduler.register('ok', '*/1 * * * *', () => {})
    await registrations[0]?.callback({ taskName: 'ok', scheduledForMs: 123 })
    expect(events.map((e) => e.type)).toEqual(['schedule.task.started', 'schedule.task.completed'])
    const started = events[0] as Extract<ScheduleEvent, { type: 'schedule.task.started' }>
    expect(started.taskName).toBe('ok')
    expect(started.scheduledForMs).toBe(123)
    expect(typeof started.startedAtMs).toBe('number')
    const completed = events[1] as Extract<ScheduleEvent, { type: 'schedule.task.completed' }>
    expect(completed.taskName).toBe('ok')
    expect(completed.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits started then completed for an async task', async () => {
    const { events, sink } = makeSink()
    const { scheduler, registrations } = build({ eventSink: sink })
    scheduler.register('ok-async', '*/1 * * * *', async () => {
      await Promise.resolve()
    })
    await registrations[0]?.callback({ taskName: 'ok-async', scheduledForMs: 0 })
    expect(events.map((e) => e.type)).toEqual(['schedule.task.started', 'schedule.task.completed'])
  })

  it('emits started then failed on throw, reports to errorReporter, resolves cleanly', async () => {
    const { events, sink } = makeSink()
    const reporter = vi.fn<ErrorReporter>()
    const { scheduler, registrations } = build({ eventSink: sink, errorReporter: reporter })
    const boom = new Error('nope')
    scheduler.register('boom', '*/1 * * * *', () => {
      throw boom
    })
    await expect(
      registrations[0]?.callback({ taskName: 'boom', scheduledForMs: 0 }),
    ).resolves.toBeUndefined()
    expect(events.map((e) => e.type)).toEqual(['schedule.task.started', 'schedule.task.failed'])
    const failed = events[1] as Extract<ScheduleEvent, { type: 'schedule.task.failed' }>
    expect(failed.taskName).toBe('boom')
    expect(failed.error.name).toBe('Error')
    expect(failed.error.message).toBe('nope')
    // `stack` is optional by contract — may be undefined on runtimes
    // without `Error.captureStackTrace` (non-V8 engines). Verify it is
    // either absent or a non-empty string rather than strictly typed.
    if (failed.error.stack !== undefined) {
      expect(typeof failed.error.stack).toBe('string')
      expect(failed.error.stack.length).toBeGreaterThan(0)
    }
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledWith(boom, { taskName: 'boom' })
  })

  it('emits only skipped (no started/completed/failed) when the lock backend blocks', async () => {
    const lockBackend = new MemoryLockBackend()
    await lockBackend.acquire('shared', 60_000) // pre-held by "another instance"

    const { events, sink } = makeSink()
    const { scheduler, registrations } = build({ eventSink: sink, lockBackend })
    let ran = 0
    scheduler.register('shared', '*/1 * * * *', () => {
      ran++
    })
    await registrations[0]?.callback({ taskName: 'shared', scheduledForMs: 0 })
    expect(ran).toBe(0)
    expect(events).toEqual([
      { type: 'schedule.task.skipped', taskName: 'shared', reason: 'locked' },
    ])
    expect(scheduler.getStats('shared').skippedCount).toBe(1)
  })

  it('getStats snapshot reflects runCount / success / error / avgDuration after N runs', async () => {
    const { scheduler, registrations } = build()
    let shouldThrow = false
    scheduler.register('many', '*/1 * * * *', async () => {
      if (shouldThrow) throw new Error('x')
    })
    const cb = registrations[0]?.callback
    await cb?.({ taskName: 'many', scheduledForMs: 0 })
    await cb?.({ taskName: 'many', scheduledForMs: 1 })
    shouldThrow = true
    await cb?.({ taskName: 'many', scheduledForMs: 2 })
    shouldThrow = false
    await cb?.({ taskName: 'many', scheduledForMs: 3 })
    const stats = scheduler.getStats('many')
    expect(stats.runCount).toBe(4)
    expect(stats.successCount).toBe(3)
    expect(stats.errorCount).toBe(1)
    expect(stats.skippedCount).toBe(0)
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0)
    expect(stats.lastRunMs).not.toBeNull()
  })

  it('getStats("unknown") returns a zeroed snapshot and does not throw', () => {
    const { scheduler } = build()
    const stats = scheduler.getStats('never-registered')
    expect(stats).toEqual({
      lastRunMs: null,
      nextRunMs: null,
      runCount: 0,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      avgDurationMs: 0,
    })
  })

  it('sink.emit that throws synchronously does not crash the wrapper', async () => {
    const events: ScheduleEvent[] = []
    const emitSpy = vi.fn<ScheduleEventSink['emit']>((e) => {
      // Throw on first call (started), allow the second (completed).
      if (emitSpy.mock.calls.length === 1) throw new Error('sink boom')
      events.push(e)
    })
    const sink: ScheduleEventSink = { emit: emitSpy }
    const { scheduler, registrations } = build({ eventSink: sink })
    scheduler.register('t', '*/1 * * * *', () => {})
    await expect(
      registrations[0]?.callback({ taskName: 't', scheduledForMs: 0 }),
    ).resolves.toBeUndefined()
    // Invariant: both emits were ATTEMPTED (so the started was not
    // skipped entirely by a regression); only the first threw.
    expect(emitSpy).toHaveBeenCalledTimes(2)
    expect(emitSpy.mock.calls[0]?.[0].type).toBe('schedule.task.started')
    expect(emitSpy.mock.calls[1]?.[0].type).toBe('schedule.task.completed')
    // Invariant: the completed event was actually recorded.
    expect(events.map((e) => e.type)).toEqual(['schedule.task.completed'])
  })

  it('errorReporter that throws does not crash the wrapper', async () => {
    const reporter: ErrorReporter = () => {
      throw new Error('reporter boom')
    }
    const { scheduler, registrations } = build({ errorReporter: reporter })
    scheduler.register('t', '*/1 * * * *', () => {
      throw new Error('task boom')
    })
    await expect(
      registrations[0]?.callback({ taskName: 't', scheduledForMs: 0 }),
    ).resolves.toBeUndefined()
  })

  it('no-sink / no-reporter scheduler still populates stats and never calls undefined hooks', async () => {
    const { scheduler, registrations } = build()
    scheduler.register('plain', '*/1 * * * *', () => {})
    await registrations[0]?.callback({ taskName: 'plain', scheduledForMs: 0 })
    const stats = scheduler.getStats('plain')
    expect(stats.runCount).toBe(1)
    expect(stats.successCount).toBe(1)
  })

  it('rejects a malformed eventSink at construction time', () => {
    expect(
      () =>
        new Scheduler({
          nativeModule: buildNative(),
          eventSink: {} as unknown as ScheduleEventSink,
        }),
    ).toThrow(expect.objectContaining({ code: 'SCHEDULE_INVALID_EVENT_SINK' }))
  })

  it('rejects a non-function errorReporter at construction time', () => {
    expect(
      () =>
        new Scheduler({
          nativeModule: buildNative(),
          errorReporter: 'not a function' as unknown as ErrorReporter,
        }),
    ).toThrow(expect.objectContaining({ code: 'SCHEDULE_INVALID_ERROR_REPORTER' }))
  })

  it('emits skipped with reason=acquire-failed when lockBackend.acquire throws', async () => {
    const { events, sink } = makeSink()
    const reporter = vi.fn<ErrorReporter>()
    const lockBackend: LockBackend = {
      acquire: async () => {
        throw new Error('redis drop')
      },
      release: async () => {},
    }
    const { scheduler, registrations } = build({
      eventSink: sink,
      errorReporter: reporter,
      lockBackend,
    })
    let ran = 0
    scheduler.register('acq-fail', '*/1 * * * *', () => {
      ran++
    })
    await registrations[0]?.callback({ taskName: 'acq-fail', scheduledForMs: 0 })
    expect(ran).toBe(0)
    expect(events).toEqual([
      { type: 'schedule.task.skipped', taskName: 'acq-fail', reason: 'acquire-failed' },
    ])
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(scheduler.getStats('acq-fail').skippedCount).toBe(1)
  })

  it('async errorReporter rejection is swallowed — ticker survives', async () => {
    const reporter: ErrorReporter = (() => {
      return async () => {
        throw new Error('async reporter boom')
      }
    })() as ErrorReporter
    const { scheduler, registrations } = build({ errorReporter: reporter })
    scheduler.register('t', '*/1 * * * *', () => {
      throw new Error('task boom')
    })
    await expect(
      registrations[0]?.callback({ taskName: 't', scheduledForMs: 0 }),
    ).resolves.toBeUndefined()
    // Let any microtask from the reporter's rejection settle.
    await new Promise((r) => setImmediate(r))
  })

  it('sink that returns a non-Promise thenable does not leak unhandled rejection', async () => {
    const sink: ScheduleEventSink = {
      emit(): void | Promise<void> {
        // Return a custom thenable whose `then` rejects asynchronously.
        const thenable = {
          // biome-ignore lint/suspicious/noThenProperty: intentional — testing non-Promise thenable handling
          then(_res: (v: undefined) => void, rej?: (e: unknown) => void) {
            setImmediate(() => rej?.(new Error('thenable boom')))
          },
        }
        return thenable as unknown as Promise<void>
      },
    }
    const { scheduler, registrations } = build({ eventSink: sink })
    scheduler.register('t', '*/1 * * * *', () => {})
    await expect(
      registrations[0]?.callback({ taskName: 't', scheduledForMs: 0 }),
    ).resolves.toBeUndefined()
    // Let the thenable rejection settle; test passes if no unhandled
    // rejection crashes the process.
    await new Promise((r) => setImmediate(r))
  })
})

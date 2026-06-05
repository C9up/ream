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

function buildFakeNative(): NonNullable<SchedulerOptions['nativeModule']> {
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

describe('Scheduler.runTaskNow', () => {
  it('returns { outcome: "unknown", durationMs: 0 } for an unregistered name', async () => {
    const scheduler = new Scheduler({ nativeModule: buildFakeNative() })
    const result = await scheduler.runTaskNow('never-registered')
    expect(result).toEqual({ outcome: 'unknown', durationMs: 0 })
  })

  it('runs a registered task that resolves, emits started+completed, updates successCount', async () => {
    const events: ScheduleEvent[] = []
    const sink: ScheduleEventSink = { emit: (e) => void events.push(e) }
    const scheduler = new Scheduler({ nativeModule: buildFakeNative(), eventSink: sink })

    let ran = 0
    scheduler.register('ok', '*/1 * * * *', () => {
      ran++
    })

    const result = await scheduler.runTaskNow('ok')
    expect(ran).toBe(1)
    expect(result.outcome).toBe('completed')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(events.map((e) => e.type)).toEqual(['schedule.task.started', 'schedule.task.completed'])
    expect(scheduler.getStats('ok').successCount).toBe(1)
  })

  it('runs a registered task that throws, emits started+failed, updates errorCount, calls errorReporter', async () => {
    const events: ScheduleEvent[] = []
    const sink: ScheduleEventSink = { emit: (e) => void events.push(e) }
    const reporter = vi.fn<ErrorReporter>()
    const scheduler = new Scheduler({
      nativeModule: buildFakeNative(),
      eventSink: sink,
      errorReporter: reporter,
    })

    scheduler.register('boom', '*/1 * * * *', () => {
      throw new Error('nope')
    })

    const result = await scheduler.runTaskNow('boom')
    expect(result.outcome).toBe('failed')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeDefined()
    expect(result.error?.name).toBe('Error')
    expect(events.map((e) => e.type)).toEqual(['schedule.task.started', 'schedule.task.failed'])
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(scheduler.getStats('boom').errorCount).toBe(1)
  })

  it('bypasses a pre-held distributed lock (admin override)', async () => {
    const lockBackend = new MemoryLockBackend()
    // Pre-hold the lock as if another instance owned it.
    await lockBackend.acquire('shared', 60_000)

    const scheduler = new Scheduler({
      nativeModule: buildFakeNative(),
      lockBackend,
    })

    let ran = 0
    scheduler.register('shared', '*/1 * * * *', () => {
      ran++
    })

    const result = await scheduler.runTaskNow('shared')
    // Despite the lock being held, runTaskNow ran the body — lock is
    // bypassed for the admin-override path.
    expect(ran).toBe(1)
    expect(result.outcome).toBe('completed')
    expect(scheduler.getStats('shared').successCount).toBe(1)
    expect(scheduler.getStats('shared').skippedCount).toBe(0)
  })

  it('does not update skippedCount when runTaskNow runs through a configured lock', async () => {
    const lockBackend: LockBackend = {
      acquire: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    }
    const scheduler = new Scheduler({
      nativeModule: buildFakeNative(),
      lockBackend,
    })
    scheduler.register('bypass', '*/1 * * * *', () => {})
    await scheduler.runTaskNow('bypass')
    // The lock backend was NOT consulted at all by runTaskNow.
    expect(lockBackend.acquire).not.toHaveBeenCalled()
    expect(lockBackend.release).not.toHaveBeenCalled()
  })

  it('concurrent runTaskNow calls for the same task — second is skipped with already-running', async () => {
    const events: ScheduleEvent[] = []
    const sink: ScheduleEventSink = { emit: (e) => void events.push(e) }
    const scheduler = new Scheduler({ nativeModule: buildFakeNative(), eventSink: sink })

    let running = 0
    let maxConcurrent = 0
    scheduler.register('slow', '*/1 * * * *', async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setImmediate(r))
      running--
    })

    const [a, b] = await Promise.all([scheduler.runTaskNow('slow'), scheduler.runTaskNow('slow')])
    // Exactly one invocation ran; the other was skipped.
    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toEqual(['already-running', 'completed'])
    expect(maxConcurrent).toBe(1)
    // Skipped event was emitted for the second caller.
    const skippedEvents = events.filter((e) => e.type === 'schedule.task.skipped')
    expect(skippedEvents).toHaveLength(1)
    expect(skippedEvents[0]).toMatchObject({ reason: 'already-running' })
  })

  it('unknown task name notifies the errorReporter with SCHEDULE_TASK_UNKNOWN', async () => {
    const reporter = vi.fn<ErrorReporter>()
    const scheduler = new Scheduler({
      nativeModule: buildFakeNative(),
      errorReporter: reporter,
    })
    const result = await scheduler.runTaskNow('nope')
    expect(result.outcome).toBe('unknown')
    expect(reporter).toHaveBeenCalledTimes(1)
    const [err, ctx] = reporter.mock.calls[0] ?? []
    expect((err as { code?: string })?.code).toBe('SCHEDULE_TASK_UNKNOWN')
    expect(ctx).toEqual({ taskName: 'nope' })
  })

  it('runTaskNow returns failed with SCHEDULE_TASK_TIMEOUT when timeoutMs elapses', async () => {
    const scheduler = new Scheduler({ nativeModule: buildFakeNative() })
    scheduler.register('slow', '*/1 * * * *', async () => {
      await new Promise((r) => setTimeout(r, 1000))
    })
    const result = await scheduler.runTaskNow('slow', { timeoutMs: 30 })
    expect(result.outcome).toBe('failed')
    expect(result.error?.name).toBe('ReamError')
    expect(result.error?.message).toContain('did not complete within 30')
  })

  it('invokes the captured wrapped closure — event payloads carry the synthetic scheduledForMs', async () => {
    const captured: ScheduleInvocation[] = []
    const scheduler = new Scheduler({ nativeModule: buildFakeNative() })
    scheduler.register('capture', '*/1 * * * *', (payload) => {
      captured.push(payload)
    })
    const before = Date.now()
    await scheduler.runTaskNow('capture')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.taskName).toBe('capture')
    // scheduledForMs is set to the Date.now() at invoke time.
    expect(captured[0]?.scheduledForMs ?? 0).toBeGreaterThanOrEqual(before)
  })
})

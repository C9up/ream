/**
 * NAPI integration tests — exercise the real `ream-scheduler-napi`
 * binary. Skipped entirely when `scheduler.*.node` is not present or
 * the binary fails to load. The 75-second ticker integration test is
 * additionally gated on `REAM_RUN_SLOW_TESTS=1` so CI does not pay its
 * wall-clock cost by default.
 *
 * @implements Story 28.2 Task 7.3
 */

import { describe, expect, it } from 'vitest'
import { type ReamError, Scheduler } from '../../src/index.js'

/** Attempt to construct a real `Scheduler`; return null if the binary is unavailable. */
function tryBuildRealScheduler(): Scheduler | null {
  try {
    return new Scheduler()
  } catch (e) {
    const err = e as ReamError
    if (
      err.code === 'SCHEDULER_NAPI_NOT_FOUND' ||
      err.code === 'SCHEDULER_UNSUPPORTED_PLATFORM' ||
      err.code === 'SCHEDULER_NAPI_LOAD_FAILED'
    ) {
      return null
    }
    throw e
  }
}

const realScheduler = tryBuildRealScheduler()
const describeIfAvailable = realScheduler ? describe : describe.skip

describeIfAvailable('Scheduler (NAPI integration)', () => {
  it('register then nextRun returns a future ms-epoch timestamp', () => {
    const s = tryBuildRealScheduler() as Scheduler
    s.register('napi-test-next', '*/1 * * * *', () => {})
    const next = s.nextRun('napi-test-next')
    expect(next).not.toBeNull()
    expect(next).toBeGreaterThan(Date.now())
    s.unregister('napi-test-next')
  })

  it('registering the same name twice surfaces DUPLICATE_TASK', () => {
    const s = tryBuildRealScheduler() as Scheduler
    s.register('napi-test-dup', '*/1 * * * *', () => {})
    expect(() => s.register('napi-test-dup', '*/1 * * * *', () => {})).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_TASK' }),
    )
    s.unregister('napi-test-dup')
  })

  it('malformed cron expression surfaces INVALID_CRON from Rust', () => {
    const s = tryBuildRealScheduler() as Scheduler
    expect(() => s.register('napi-test-bad', 'not a real cron', () => {})).toThrow(
      expect.objectContaining({ code: 'INVALID_CRON' }),
    )
  })

  it('unregister clears nextRun for a previously-registered task', () => {
    const s = tryBuildRealScheduler() as Scheduler
    s.register('napi-test-rm', '*/1 * * * *', () => {})
    expect(s.nextRun('napi-test-rm')).not.toBeNull()
    s.unregister('napi-test-rm')
    expect(s.nextRun('napi-test-rm')).toBeNull()
  })

  it('listTasks returns name + cronExpr + nextRun for every registered task', () => {
    const s = tryBuildRealScheduler() as Scheduler
    s.register('napi-test-list-a', '0 * * * *', () => {})
    s.register('napi-test-list-b', '*/5 * * * *', () => {})

    const names = s
      .listTasks()
      .map((t) => t.name)
      .filter((n) => n.startsWith('napi-test-list-'))
      .sort()
    expect(names).toEqual(['napi-test-list-a', 'napi-test-list-b'])
    for (const t of s.listTasks()) {
      if (!t.name.startsWith('napi-test-list-')) continue
      expect(t.cronExpr.length).toBeGreaterThan(0)
      expect(t.nextRun).not.toBeNull()
    }
    s.unregister('napi-test-list-a')
    s.unregister('napi-test-list-b')
  })
})

// Real-time slow integration: only runs when explicitly enabled.
const slow = process.env.REAM_RUN_SLOW_TESTS === '1'
const describeIfSlow = realScheduler && slow ? describe : describe.skip

describeIfSlow('Scheduler (NAPI slow integration)', () => {
  it('ticker fires a `*/1 * * * *` task at least once within 75 seconds', async () => {
    const s = tryBuildRealScheduler() as Scheduler
    let fires = 0
    s.register('napi-slow-tick', '*/1 * * * *', () => {
      fires += 1
    })
    s.start()

    const deadline = Date.now() + 75_000
    while (fires === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }
    s.stop()
    s.unregister('napi-slow-tick')
    expect(fires).toBeGreaterThanOrEqual(1)
  }, 80_000)
})

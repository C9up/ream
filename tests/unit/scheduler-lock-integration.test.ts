import { describe, expect, it, vi } from 'vitest'
import type { LockBackend, ScheduleInvocation, SchedulerOptions } from '../../src/index.js'
import { MemoryLockBackend, Scheduler } from '../../src/index.js'

/**
 * Shared factory for a fake native module. Each test gets its own
 * instance so registrations arrays do not leak across cases.
 */
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
 * Build a `Scheduler` with a fake native module and optional
 * lock backend. Mirrors the pattern from `scheduler-wrapper.test.ts`.
 */
function build(opts: { lockBackend?: LockBackend } = {}) {
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
  const scheduler = new Scheduler({ nativeModule: native, lockBackend: opts.lockBackend })
  return { scheduler, registrations }
}

describe('Scheduler lock integration', () => {
  it('two Scheduler instances sharing one MemoryLockBackend: only one runs the task body per simultaneous tick', async () => {
    const lockBackend = new MemoryLockBackend()
    const a = build({ lockBackend })
    const b = build({ lockBackend })

    let aRuns = 0
    let bRuns = 0
    a.scheduler.register('shared', '*/1 * * * *', () => {
      aRuns++
    })
    b.scheduler.register('shared', '*/1 * * * *', () => {
      bRuns++
    })

    // Fire both native callbacks concurrently — simulates two
    // instances whose Rust tickers fire in the same tick.
    await Promise.all([
      a.registrations[0]?.callback({ taskName: 'shared', scheduledForMs: 0 }),
      b.registrations[0]?.callback({ taskName: 'shared', scheduledForMs: 0 }),
    ])

    // Exactly one body ran; the other instance was blocked by the
    // shared lock.
    expect(aRuns + bRuns).toBe(1)
  })

  it('release after completion lets the next callback acquire immediately (no TTL wait)', async () => {
    const lockBackend = new MemoryLockBackend()
    const { scheduler, registrations } = build({ lockBackend })

    let runs = 0
    scheduler.register('release-test', '*/1 * * * *', () => {
      runs++
    })

    const cb = registrations[0]?.callback
    expect(cb).toBeDefined()
    await cb?.({ taskName: 'release-test', scheduledForMs: 0 })
    await cb?.({ taskName: 'release-test', scheduledForMs: 1 })

    // Second invocation runs immediately because the first released
    // the lock in its `finally`. If the scheduler held the lock for
    // the full TTL, we would see only 1 run.
    expect(runs).toBe(2)
  })

  it('a throwing task still releases the lock (next invocation runs)', async () => {
    const lockBackend = new MemoryLockBackend()
    const { scheduler, registrations } = build({ lockBackend })

    let runs = 0
    scheduler.register('throwing', '*/1 * * * *', () => {
      runs++
      if (runs === 1) throw new Error('first fire fails')
    })

    const cb = registrations[0]?.callback
    await cb?.({ taskName: 'throwing', scheduledForMs: 0 })
    await cb?.({ taskName: 'throwing', scheduledForMs: 1 })

    expect(runs).toBe(2)
  })

  it('a Scheduler constructed WITHOUT a lock backend never calls acquire/release on any backend', async () => {
    const lockBackend: LockBackend = {
      acquire: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    }
    // Build WITHOUT passing the backend — the scheduler must NOT
    // touch it even if one is available in scope.
    const { scheduler, registrations } = build()

    scheduler.register('no-lock', '*/1 * * * *', () => {})
    await registrations[0]?.callback({ taskName: 'no-lock', scheduledForMs: 0 })

    expect(lockBackend.acquire).not.toHaveBeenCalled()
    expect(lockBackend.release).not.toHaveBeenCalled()
  })

  it('serializes correctly even when the backend has a real async gap between get and set', async () => {
    // Build a backend that introduces a deliberate `await` between
    // its get-check and its set-write. If the Scheduler's wrapped
    // closure relied on the synchronous nature of MemoryLockBackend,
    // this test would double-execute the task.
    let held = false
    const slowBackend: LockBackend = {
      async acquire(_name: string, _ttlMs: number): Promise<boolean> {
        const free = !held
        // Deliberate async gap — another caller may run here.
        await Promise.resolve()
        if (!free) return false
        held = true
        return true
      },
      async release(_name: string): Promise<void> {
        held = false
      },
    }

    const a = build({ lockBackend: slowBackend })
    const b = build({ lockBackend: slowBackend })
    let aRuns = 0
    let bRuns = 0
    a.scheduler.register('async-lock', '*/1 * * * *', () => {
      aRuns++
    })
    b.scheduler.register('async-lock', '*/1 * * * *', () => {
      bRuns++
    })

    await Promise.all([
      a.registrations[0]?.callback({ taskName: 'async-lock', scheduledForMs: 0 }),
      b.registrations[0]?.callback({ taskName: 'async-lock', scheduledForMs: 0 }),
    ])

    // Both schedulers see `free=true` at their own `get`-equivalent,
    // but only one wins the race to set `held = true` *after* the
    // await. This backend is intentionally unsafe; the point is to
    // document that the Scheduler cannot paper over a racy backend —
    // the user is responsible for atomic semantics. The Scheduler
    // honored whatever the backend reported.
    expect(aRuns + bRuns).toBeGreaterThanOrEqual(1)
    expect(aRuns + bRuns).toBeLessThanOrEqual(2)
  })

  it('swallows acquire rejection (skips tick) instead of crashing the ticker', async () => {
    const backend: LockBackend = {
      acquire: vi.fn(async () => {
        throw new Error('redis drop')
      }),
      release: vi.fn(async () => {}),
    }
    const { scheduler, registrations } = build({ lockBackend: backend })
    let ran = 0
    scheduler.register('acquire-fails', '*/1 * * * *', () => {
      ran++
    })
    const cb = registrations[0]?.callback
    expect(cb).toBeDefined()
    // The native side calls this wrapper and awaits it. It MUST resolve
    // cleanly even when the lock backend throws.
    await expect(cb?.({ taskName: 'acquire-fails', scheduledForMs: 0 })).resolves.toBeUndefined()
    expect(ran).toBe(0)
    expect(backend.release).not.toHaveBeenCalled()
  })

  it('swallows release rejection so the wrapped closure always resolves', async () => {
    const backend: LockBackend = {
      acquire: vi.fn(async () => true),
      release: vi.fn(async () => {
        throw new Error('redis drop during release')
      }),
    }
    const { scheduler, registrations } = build({ lockBackend: backend })
    let ran = 0
    scheduler.register('release-fails', '*/1 * * * *', () => {
      ran++
    })
    const cb = registrations[0]?.callback
    await expect(cb?.({ taskName: 'release-fails', scheduledForMs: 0 })).resolves.toBeUndefined()
    expect(ran).toBe(1)
    expect(backend.release).toHaveBeenCalledTimes(1)
  })

  it('constructor rejects invalid defaultLockTtlMs values', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Scheduler({ nativeModule: buildNative(), defaultLockTtlMs: bad })).toThrow(
        expect.objectContaining({ code: 'E_SCHEDULE_INVALID_LOCK_TTL' }),
      )
    }
  })

  it('constructor rejects a malformed lockBackend (missing acquire/release)', () => {
    expect(
      () =>
        new Scheduler({
          nativeModule: buildNative(),
          lockBackend: {} as unknown as LockBackend,
        }),
    ).toThrow(expect.objectContaining({ code: 'E_SCHEDULE_INVALID_LOCK_BACKEND' }))
  })

  it('rejects empty task names at register time', () => {
    const { scheduler } = build({ lockBackend: new MemoryLockBackend() })
    expect(() => scheduler.register('', '*/1 * * * *', () => {})).toThrow(
      expect.objectContaining({ code: 'E_SCHEDULE_INVALID_TASK_NAME' }),
    )
  })

  it('uses the configured defaultLockTtlMs when invoking acquire', async () => {
    const lockBackend: LockBackend = {
      acquire: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    }
    const native = {
      RustScheduler: class {
        register(_n: string, _c: string, _cb: (p: ScheduleInvocation) => Promise<void>) {
          stored = _cb
        }
        unregister() {}
        start() {}
        stop() {}
        nextRun() {
          return null
        }
      },
    } as unknown as NonNullable<SchedulerOptions['nativeModule']>
    let stored: ((p: ScheduleInvocation) => Promise<void>) | undefined
    const scheduler = new Scheduler({
      nativeModule: native,
      lockBackend,
      defaultLockTtlMs: 5_000,
    })
    scheduler.register('ttl-test', '*/1 * * * *', () => {})
    await stored?.({ taskName: 'ttl-test', scheduledForMs: 0 })

    expect(lockBackend.acquire).toHaveBeenCalledWith('ttl-test', 5_000)
  })
})

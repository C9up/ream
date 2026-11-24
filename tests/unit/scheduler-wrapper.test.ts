import { describe, expect, it, vi } from 'vitest'
import type { ScheduleInvocation } from '../../src/index.js'
import { errors, Scheduler } from '../../src/index.js'

/**
 * These tests exercise the `Scheduler` TS wrapper by injecting a fake
 * native module — no NAPI `.node` required. Behaviour that depends on
 * the real Rust ticker (tick cadence, cron math) is covered by the
 * `ream-scheduler` crate's Rust tests; here we only verify the TS
 * adapter shape.
 */
describe('Scheduler (wrapper)', () => {
  function fakeNativeScheduler() {
    return {
      register: vi.fn(),
      unregister: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      // Typed by the call it stands in for, so `mockImplementation` can take
      // one: inferred from `() => null`, the mock accepted no argument and no
      // number back.
      nextRun: vi.fn<(name: string) => number | null>(() => null),
    }
  }

  function build() {
    const native = fakeNativeScheduler()
    const scheduler = new Scheduler({
      nativeModule: {
        RustScheduler: class {
          constructor() {
            Object.assign(this, native)
          }
        } as unknown as { new (): typeof native },
      },
    })
    return { native, scheduler }
  }

  it('register passes through to the native surface and tracks the task locally', () => {
    const { native, scheduler } = build()
    scheduler.register('cleanup', '*/5 * * * *', () => {})
    expect(native.register).toHaveBeenCalledTimes(1)
    const [name, cron] = native.register.mock.calls[0] ?? []
    expect(name).toBe('cleanup')
    expect(cron).toBe('*/5 * * * *')
    expect(scheduler.listTasks()).toEqual([
      { name: 'cleanup', cronExpr: '*/5 * * * *', nextRun: null },
    ])
  })

  it('wraps the user callback so synchronous throws never propagate to the Rust ticker', async () => {
    const { native, scheduler } = build()
    scheduler.register('boom', '*/1 * * * *', () => {
      throw new Error('sync fail')
    })
    const wrapper = native.register.mock.calls[0]?.[2] as (p: ScheduleInvocation) => Promise<void>
    await expect(wrapper({ taskName: 'boom', scheduledForMs: 0 })).resolves.toBeUndefined()
  })

  it('wraps the user callback so async rejections never propagate', async () => {
    const { native, scheduler } = build()
    scheduler.register('boom-async', '*/1 * * * *', async () => {
      throw new Error('async fail')
    })
    const wrapper = native.register.mock.calls[0]?.[2] as (p: ScheduleInvocation) => Promise<void>
    await expect(wrapper({ taskName: 'boom-async', scheduledForMs: 0 })).resolves.toBeUndefined()
  })

  it('rethrows a coded native error as its E_SCHEDULER_* class', () => {
    const { native, scheduler } = build()
    const nativeError = new Error(
      JSON.stringify({
        code: 'DUPLICATE_TASK',
        message: "Task 'dup' is already registered",
        hint: 'Unregister the existing task first or use a unique name',
        context: { task: 'dup' },
      }),
    )
    native.register.mockImplementationOnce(() => {
      throw nativeError
    })
    const thrown = (() => {
      try {
        scheduler.register('dup', '*/1 * * * *', () => {})
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(thrown).toBeInstanceOf(errors.E_SCHEDULER_DUPLICATE_TASK)
    expect(thrown).toMatchObject({
      code: 'E_SCHEDULER_DUPLICATE_TASK',
      message: "Task 'dup' is already registered",
      help: 'Unregister the existing task first or use a unique name',
      cause: nativeError,
    })
  })

  it('rethrows any other native failure as E_SCHEDULER_NATIVE_ERROR', () => {
    const { native, scheduler } = build()
    native.register.mockImplementationOnce(() => {
      throw new Error(
        JSON.stringify({ code: 'E_NATIVE_PANIC', message: 'Rust panic caught: boom' }),
      )
    })
    expect(() => scheduler.register('p', '*/1 * * * *', () => {})).toThrow(
      expect.objectContaining({
        code: 'E_SCHEDULER_NATIVE_ERROR',
        message: 'ream-scheduler NAPI call failed: [E_NATIVE_PANIC] Rust panic caught: boom',
      }),
    )
    native.register.mockImplementationOnce(() => {
      throw new Error('not json')
    })
    expect(() => scheduler.register('q', '*/1 * * * *', () => {})).toThrow(
      expect.objectContaining({ code: 'E_SCHEDULER_NATIVE_ERROR' }),
    )
  })

  it('rethrows a callback napi could not hold under its own code', () => {
    const { native, scheduler } = build()
    const nativeError = new Error(
      JSON.stringify({
        code: 'E_NATIVE_CALLBACK_FAILED',
        message: 'Could not hold the JavaScript callback: InvalidArg',
      }),
    )
    native.register.mockImplementationOnce(() => {
      throw nativeError
    })
    expect(() => scheduler.register('b', '*/1 * * * *', () => {})).toThrow(
      expect.objectContaining({
        code: 'E_NATIVE_CALLBACK_FAILED',
        message: 'Could not hold the JavaScript callback: InvalidArg',
        cause: nativeError,
      }),
    )
  })

  it('unregister drops the task from the local task map', () => {
    const { scheduler } = build()
    scheduler.register('temp', '*/5 * * * *', () => {})
    expect(scheduler.listTasks()).toHaveLength(1)
    scheduler.unregister('temp')
    expect(scheduler.listTasks()).toHaveLength(0)
  })

  it('nextRun surfaces the native return value', () => {
    const { native, scheduler } = build()
    native.nextRun.mockReturnValueOnce(1_700_000_000_000)
    scheduler.register('x', '*/1 * * * *', () => {})
    expect(scheduler.nextRun('x')).toBe(1_700_000_000_000)
    native.nextRun.mockReturnValueOnce(null)
    expect(scheduler.nextRun('missing')).toBeNull()
  })

  it('listTasks returns name, cronExpr, and nextRun for every registered task', () => {
    const { native, scheduler } = build()
    native.nextRun.mockImplementation((name: string): number | null =>
      name === 'a' ? 42 : name === 'b' ? 99 : null,
    )
    scheduler.register('a', '0 * * * *', () => {})
    scheduler.register('b', '*/5 * * * *', () => {})
    const list = scheduler.listTasks().sort((x, y) => x.name.localeCompare(y.name))
    expect(list).toEqual([
      { name: 'a', cronExpr: '0 * * * *', nextRun: 42 },
      { name: 'b', cronExpr: '*/5 * * * *', nextRun: 99 },
    ])
  })

  it('start / stop pass through to the native layer', () => {
    const { native, scheduler } = build()
    scheduler.start()
    scheduler.stop()
    expect(native.start).toHaveBeenCalledTimes(1)
    expect(native.stop).toHaveBeenCalledTimes(1)
  })
})

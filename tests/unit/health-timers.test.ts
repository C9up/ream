import { afterEach, describe, expect, it, vi } from 'vitest'
import { HealthCheck } from '../../src/HealthCheck.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('HealthCheck > timeout timers', () => {
  it('leaves no timer armed once every check has answered', async () => {
    vi.useFakeTimers()
    const health = new HealthCheck({ checkTimeout: 3000 })
    health.register('db', () => ({ name: 'db', status: 'ok' }))
    health.register('cache', async () => ({ name: 'cache', status: 'ok' }))
    const status = await health.check()
    expect(status.status).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer of a check that rejects', async () => {
    vi.useFakeTimers()
    const health = new HealthCheck({ checkTimeout: 3000 })
    health.register('db', async () => {
      throw new Error('down')
    })
    const status = await health.check()
    expect(status.checks[0]?.message).toBe('down')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs checks concurrently, so slow checks cost one timeout, not one each', async () => {
    vi.useFakeTimers()
    const health = new HealthCheck({ checkTimeout: 1000 })
    const never = (): Promise<never> => new Promise(() => {})
    health.register('a', never)
    health.register('b', never)
    health.register('ok', () => ({ name: 'ok', status: 'ok' }))
    const pending = health.check()
    await vi.advanceTimersByTimeAsync(1000)
    const status = await pending
    expect(status.checks.map((check) => [check.name, check.status])).toEqual([
      ['a', 'error'],
      ['b', 'error'],
      ['ok', 'ok'],
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})

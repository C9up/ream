/**
 * `resolve()` is async, so a singleton factory could be entered twice at cold
 * start: both callers passed the cache check before either finished. The first
 * instance was then silently discarded — a second connection pool, a second
 * scheduler, and no error anywhere.
 */
import { describe, expect, it, vi } from 'vitest'
import { Container } from '../../src/container/Container.js'

describe('ream > singleton under concurrency', () => {
  it('runs an async factory once, however many callers arrive', async () => {
    const container = new Container()
    const factory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { id: Symbol('instance') }
    })
    container.singleton('db', factory)

    const resolved = await Promise.all(Array.from({ length: 8 }, () => container.resolve('db')))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(new Set(resolved).size).toBe(1)
  })

  it('hands later callers the same instance', async () => {
    const container = new Container()
    container.singleton('db', async () => ({}))
    const [first] = await Promise.all([container.resolve('db'), container.resolve('db')])
    expect(await container.resolve('db')).toBe(first)
  })

  it('runs the resolving hooks once, not once per waiting caller', async () => {
    const container = new Container()
    const hook = vi.fn()
    container.singleton('db', async () => ({}))
    container.resolving('db', hook)
    await Promise.all([container.resolve('db'), container.resolve('db'), container.resolve('db')])
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('lets a failed build be retried instead of poisoning the key', async () => {
    const container = new Container()
    let attempt = 0
    container.singleton('db', async () => {
      attempt++
      if (attempt === 1) throw new Error('connection refused')
      return { ok: true }
    })

    await expect(Promise.all([container.resolve('db'), container.resolve('db')])).rejects.toThrow(
      'connection refused',
    )
    // The transient failure is over; the next resolve must build.
    expect(await container.resolve('db')).toEqual({ ok: true })
  })

  it('still builds a transient binding per call', async () => {
    const container = new Container()
    const factory = vi.fn(async () => ({}))
    container.bind('scoped', factory)
    await Promise.all([container.resolve('scoped'), container.resolve('scoped')])
    expect(factory).toHaveBeenCalledTimes(2)
  })
})

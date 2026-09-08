import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'

/**
 * Cycle detection under CONCURRENT resolution.
 *
 * `resolve()` is async, so two independent chains interleave. A detector whose
 * stack lives on the container sees them as one chain and reports a cycle that
 * does not exist — and the report even looks plausible, because it is two real
 * chains concatenated. In kitchen-sink this surfaced as
 * `nova → SubscriptionStore → router → SubscriptionStore` and took out seven
 * e2e files.
 */
describe('Container — concurrent resolution', () => {
  /** A binding that yields to the event loop before returning, like a real one. */
  function slow<T>(container: Container, token: string, build: () => Promise<T> | T): void {
    container.singleton(token, async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return build()
    })
  }

  it('does not report a cycle for two chains sharing a dependency', async () => {
    const container = new Container()
    slow(container, 'shared', () => ({ name: 'shared' }))
    slow(container, 'left', async () => ({ dep: await container.resolve('shared') }))
    slow(container, 'right', async () => ({ dep: await container.resolve('shared') }))

    // Both chains are in flight at once and both pass through `shared`.
    const [left, right] = await Promise.all([
      container.resolve<{ dep: unknown }>('left'),
      container.resolve<{ dep: unknown }>('right'),
    ])

    expect(left.dep).toBeDefined()
    expect(right.dep).toBeDefined()
  })

  it('does not report a cycle for many interleaved chains', async () => {
    const container = new Container()
    slow(container, 'leaf', () => 'leaf')
    for (let i = 0; i < 8; i += 1) {
      slow(container, `branch${i}`, async () => container.resolve('leaf'))
    }

    const resolved = await Promise.all(
      Array.from({ length: 8 }, (_, i) => container.resolve<string>(`branch${i}`)),
    )

    expect(resolved).toEqual(Array.from({ length: 8 }, () => 'leaf'))
  })

  it('still catches a REAL cycle', async () => {
    // The detector has to keep doing its job — the fix is to scope the chain,
    // not to stop looking.
    const container = new Container()
    container.singleton('a', async () => container.resolve('b'))
    container.singleton('b', async () => container.resolve('a'))

    await expect(container.resolve('a')).rejects.toThrow(/Circular dependency/)
  })

  it('still catches a real cycle while other chains are in flight', async () => {
    const container = new Container()
    slow(container, 'unrelated', () => 'fine')
    container.singleton('x', async () => container.resolve('y'))
    container.singleton('y', async () => container.resolve('x'))

    const [unrelated, cyclic] = await Promise.allSettled([
      container.resolve('unrelated'),
      container.resolve('x'),
    ])

    expect(unrelated.status).toBe('fulfilled')
    expect(cyclic.status).toBe('rejected')
  })
})

/**
 * Rebinding a token has to replace what it produced.
 *
 * Resolution reads the cache BEFORE the binding, so a token re-registered with
 * a new factory kept answering with the old instance — a rebind that changed
 * nothing, silently. That is exactly what a provider does when it boots a
 * second time in one process, so the container went on handing out the
 * connection the previous shutdown had closed.
 */
describe('container > rebinding a token', () => {
  it('forgets the instance the previous binding produced', async () => {
    const container = new Container()
    container.singleton('db', () => ({ id: 1 }))
    expect(await container.resolve<{ id: number }>('db')).toEqual({ id: 1 })

    container.singleton('db', () => ({ id: 2 }))

    expect(await container.resolve<{ id: number }>('db')).toEqual({ id: 2 })
  })

  it('forgets it when rebinding from singleton to transient too', async () => {
    const container = new Container()
    container.singleton('db', () => ({ id: 1 }))
    await container.resolve('db')

    container.bind('db', () => ({ id: 2 }))

    expect(await container.resolve<{ id: number }>('db')).toEqual({ id: 2 })
  })

  it('does not let an in-flight resolution become the new binding’s value', async () => {
    const container = new Container()
    let release: (value: { id: number }) => void = () => {}
    container.singleton(
      'db',
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const inFlight = container.resolve<{ id: number }>('db')

    container.singleton('db', () => ({ id: 2 }))
    release({ id: 1 })
    await inFlight

    // The awaited OLD factory must not be what the new binding answers with.
    expect(await container.resolve<{ id: number }>('db')).toEqual({ id: 2 })
  })
})

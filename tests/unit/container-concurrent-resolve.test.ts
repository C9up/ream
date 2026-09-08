import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { Inject, Service } from '../../src/decorators/Service.js'

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

/**
 * A singleton whose initialisation failed must not be published.
 *
 * The instance was cached BEFORE the `resolving` hooks ran, so a hook that
 * threw left it in the cache: the caller saw the error, and the NEXT resolution
 * was handed the same half-built object with no hook, no error, and nothing to
 * say a step had been skipped. A hook that opens a connection, validates a
 * config or wraps a security decorator failing is exactly when the instance
 * must not be reachable.
 */
describe('container > a failed resolving hook must not publish the singleton', () => {
  it('does not hand the half-built instance to the next caller', async () => {
    const container = new Container()
    let factoryCalls = 0
    let hookCalls = 0
    container.singleton('service', () => {
      factoryCalls += 1
      return { id: factoryCalls }
    })
    container.resolving('service', () => {
      hookCalls += 1
      throw new Error('hook failed')
    })

    await expect(container.resolve('service')).rejects.toThrow('hook failed')
    // The second attempt must REBUILD and fail again, not succeed on a cached
    // object the hook never finished with.
    await expect(container.resolve('service')).rejects.toThrow('hook failed')

    expect(factoryCalls).toBe(2)
    expect(hookCalls).toBe(2)
  })

  it('still caches once the hooks succeed', async () => {
    const container = new Container()
    let factoryCalls = 0
    container.singleton('service', () => {
      factoryCalls += 1
      return { id: factoryCalls }
    })
    container.resolving('service', () => {})

    const first = await container.resolve<{ id: number }>('service')
    const second = await container.resolve<{ id: number }>('service')

    expect(second).toBe(first)
    expect(factoryCalls).toBe(1)
  })

  it('runs the hooks once for concurrent callers', async () => {
    // The pending promise is what keeps a second build from starting; moving
    // the cache after the hooks must not cost that.
    const container = new Container()
    let hookCalls = 0
    container.singleton('service', async () => ({ id: 1 }))
    container.resolving('service', () => {
      hookCalls += 1
    })

    const [a, b] = await Promise.all([
      container.resolve<{ id: number }>('service'),
      container.resolve<{ id: number }>('service'),
    ])

    expect(a).toBe(b)
    expect(hookCalls).toBe(1)
  })
})

/**
 * The same rule, for a class the container builds itself.
 *
 * `@Service({ scope: 'singleton' })` never goes through an explicit binding:
 * `resolve()` falls through to auto-construction, which cached the instance
 * on its way out and left the hooks to run afterwards — the exact ordering
 * the explicit path was fixed for, on the path most applications actually use.
 */
describe('container > an auto-constructed singleton follows the same pipeline', () => {
  it('does not publish an instance whose resolving hook threw', async () => {
    const container = new Container()
    let built = 0
    let hookCalls = 0

    @Service({ scope: 'singleton' })
    class Broken {
      readonly id: number
      constructor() {
        built += 1
        this.id = built
      }
    }

    container.resolving(Broken, () => {
      hookCalls += 1
      throw new Error('hook failed')
    })

    await expect(container.resolve(Broken)).rejects.toThrow('hook failed')
    await expect(container.resolve(Broken)).rejects.toThrow('hook failed')

    expect(built).toBe(2)
    expect(hookCalls).toBe(2)
  })

  it('builds one instance for two concurrent callers', async () => {
    // Auto-construction never joined `#pendingSingletons`, so two resolutions
    // in flight at once each built their own — two singletons, and whichever
    // finished last was the one everybody else got.
    const container = new Container()
    let built = 0
    container.singleton('slow', async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return { name: 'slow' }
    })

    @Service({ scope: 'singleton' })
    class Shared {
      readonly id: number
      constructor(@Inject('slow') readonly dep: unknown) {
        built += 1
        this.id = built
      }
    }

    const [a, b] = await Promise.all([
      container.resolve<Shared>(Shared),
      container.resolve<Shared>(Shared),
    ])

    expect(a).toBe(b)
    expect(built).toBe(1)
  })

  it('still caches once the hooks succeed', async () => {
    const container = new Container()
    let built = 0

    @Service({ scope: 'singleton' })
    class Fine {
      readonly id: number
      constructor() {
        built += 1
        this.id = built
      }
    }

    const first = await container.resolve<Fine>(Fine)
    const second = await container.resolve<Fine>(Fine)

    expect(second).toBe(first)
    expect(built).toBe(1)
  })
})

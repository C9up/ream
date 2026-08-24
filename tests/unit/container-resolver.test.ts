/**
 * `container.createResolver()` — AdonisJS Fold's per-request resolver.
 *
 * The point of the class is ISOLATION: a value bound for one request must be
 * visible to everything that request builds, including its dependencies'
 * dependencies, and invisible to every other request and to the container
 * itself. Binding on the container instead is the bug this exists to prevent.
 */

import 'reflect-metadata'
import { beforeEach, describe, expect, it } from 'vitest'
import { Container, Inject, Service } from '../../src/index.js'

class RequestId {
  constructor(readonly value: string = 'none') {}
}

@Service()
class Repo {
  constructor(@Inject(RequestId) readonly id: RequestId) {}
}

@Service()
class Controller {
  constructor(@Inject(Repo) readonly repo: Repo) {}
}

describe('container > createResolver', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('injects a bound value into what it builds', async () => {
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('req-1'))

    const repo = await resolver.make<Repo>(Repo)

    expect(repo.id.value).toBe('req-1')
  })

  it('reaches a dependency of a dependency', async () => {
    // The whole reason the value rides on the resolution chain: the controller
    // never mentions RequestId, its repository does.
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('deep'))

    const controller = await resolver.make<Controller>(Controller)

    expect(controller.repo.id.value).toBe('deep')
  })

  it('keeps two resolvers from seeing each other', async () => {
    const a = container.createResolver()
    const b = container.createResolver()
    a.bindValue(RequestId, new RequestId('a'))
    b.bindValue(RequestId, new RequestId('b'))

    const [ra, rb] = await Promise.all([a.make<Repo>(Repo), b.make<Repo>(Repo)])

    expect(ra.id.value).toBe('a')
    expect(rb.id.value).toBe('b')
  })

  it('does not leak the bound value into the container', async () => {
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('scoped'))
    await resolver.make<Repo>(Repo)

    // Straight off the container: the request's value must be gone.
    const direct = await container.make<Repo>(Repo)

    expect(direct.id.value).toBe('none')
  })

  it('stays isolated across interleaved async resolutions', async () => {
    // The values ride on an AsyncLocalStorage chain; two resolutions that
    // interleave must not splice. A binding that awaits proves it.
    container.bind('slow', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 'ok'
    })
    const a = container.createResolver()
    const b = container.createResolver()
    a.bindValue(RequestId, new RequestId('first'))
    b.bindValue(RequestId, new RequestId('second'))

    const [ra, rb] = await Promise.all([
      a.make<Repo>(Repo).then(async (r) => {
        await container.make('slow')
        return r
      }),
      b.make<Repo>(Repo),
    ])

    expect(ra.id.value).toBe('first')
    expect(rb.id.value).toBe('second')
  })

  it('falls through to the container for anything it did not bind', async () => {
    container.singleton('greeting', () => 'hello')
    const resolver = container.createResolver()

    expect(await resolver.make<string>('greeting')).toBe('hello')
  })

  it('lets a swap win, as the container does', async () => {
    container.singleton(RequestId, () => new RequestId('bound'))
    container.swap(RequestId, () => new RequestId('swapped'))
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('scoped'))

    // Test overrides sit above everything, resolver values included —
    // @adonisjs/fold checks swaps first in `resolveFor`.
    expect((await resolver.make<RequestId>(RequestId)).value).toBe('swapped')
  })

  it('reports what resolves', () => {
    container.singleton('mailer', () => ({}))
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('x'))

    expect(resolver.hasBinding(RequestId)).toBe(true)
    expect(resolver.hasBinding('mailer')).toBe(true)
    expect(resolver.hasBinding('nope')).toBe(false)
    expect(resolver.hasAllBindings([RequestId, 'mailer'])).toBe(true)
    expect(resolver.hasAllBindings([RequestId, 'nope'])).toBe(false)
  })

  it('injects bound values into a called method', async () => {
    class Handler {
      async run(@Inject(RequestId) id?: RequestId): Promise<string> {
        return id?.value ?? 'missing'
      }
    }
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('called'))

    expect(await resolver.call(new Handler(), 'run')).toBe('called')
  })
})

describe('container > createResolver and singleton caching', () => {
  it('still caches a singleton that read nothing request-scoped', async () => {
    const container = new Container()
    let built = 0
    @Service()
    class Cacheable {
      constructor() {
        built += 1
      }
    }
    const resolver = container.createResolver()
    resolver.bindValue(RequestId, new RequestId('unused'))

    await resolver.make(Cacheable)
    await container.make(Cacheable)

    // The request's value was never read, so the instance is the application's.
    expect(built).toBe(1)
  })

  it('refuses to cache a singleton that captured a request value', async () => {
    // Caching it would hand the first request's state to every later one.
    const container = new Container()
    const a = container.createResolver()
    const b = container.createResolver()
    a.bindValue(RequestId, new RequestId('first'))
    b.bindValue(RequestId, new RequestId('second'))

    expect((await a.make<Repo>(Repo)).id.value).toBe('first')
    expect((await b.make<Repo>(Repo)).id.value).toBe('second')
  })
})

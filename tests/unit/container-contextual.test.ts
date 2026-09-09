/**
 * Contextual bindings — AdonisJS `container.when(X).asksFor(Y).provide(...)`.
 *
 * "When THIS class asks for that dependency, give it this instead." Everyone
 * else keeps the container's binding, which is the whole point: the override is
 * scoped to one dependent, not to the application.
 */

import 'reflect-metadata'
import { beforeEach, describe, expect, it } from 'vitest'
import { Container, Inject, Service } from '../../src/index.js'

abstract class Hash {
  abstract name(): string
}

class Bcrypt extends Hash {
  name(): string {
    return 'bcrypt'
  }
}

class Argon2 extends Hash {
  name(): string {
    return 'argon2'
  }
}

@Service({ scope: 'transient' })
class UsersController {
  constructor(@Inject(Hash) readonly hash: Hash) {}
}

@Service({ scope: 'transient' })
class SessionsController {
  constructor(@Inject(Hash) readonly hash: Hash) {}
}

/** Two hops: the controller asks for a service, the service asks for the hash. */
@Service({ scope: 'transient' })
class PasswordService {
  constructor(@Inject(Hash) readonly hash: Hash) {}
}

@Service({ scope: 'transient' })
class AdminController {
  constructor(@Inject(PasswordService) readonly passwords: PasswordService) {}
}

describe('container > contextual bindings', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
    container.bind(Hash, () => new Bcrypt())
  })

  it('gives the named class its own implementation', async () => {
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => new Argon2())

    const users = await container.make<UsersController>(UsersController)

    expect(users.hash.name()).toBe('argon2')
  })

  it('leaves every other class on the container binding', async () => {
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => new Argon2())

    const sessions = await container.make<SessionsController>(SessionsController)

    expect(sessions.hash.name()).toBe('bcrypt')
    // And resolving the hash on its own is untouched.
    expect((await container.make<Hash>(Hash)).name()).toBe('bcrypt')
  })

  it('keys on the DIRECT dependent, not on an ancestor', async () => {
    // AdonisJS scopes a contextual binding to the class that declares the
    // dependency. AdminController does not ask for Hash — PasswordService does.
    container
      .when(AdminController)
      .asksFor(Hash)
      .provide(() => new Argon2())

    const admin = await container.make<AdminController>(AdminController)

    expect(admin.passwords.hash.name()).toBe('bcrypt')
  })

  it('applies to the class that really asks, two hops down', async () => {
    container
      .when(PasswordService)
      .asksFor(Hash)
      .provide(() => new Argon2())

    const admin = await container.make<AdminController>(AdminController)

    expect(admin.passwords.hash.name()).toBe('argon2')
  })

  it('accepts the single-call spelling too', async () => {
    container.contextualBinding(UsersController, Hash, () => new Argon2())

    expect((await container.make<UsersController>(UsersController)).hash.name()).toBe('argon2')
  })

  it('refuses provide() before asksFor()', () => {
    expect(() => container.when(UsersController).provide(() => new Argon2())).toThrow(/asksFor/)
  })

  it('lets a swap win, as it does over resolver values', () => {
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => new Argon2())
    container.swap(Hash, () => new Bcrypt())

    // Test overrides sit above everything — @adonisjs/fold checks swaps first.
    return expect(
      container.make<UsersController>(UsersController).then((c) => c.hash.name()),
    ).resolves.toBe('bcrypt')
  })

  it('resolves a method dependency contextually too', async () => {
    class Handler {
      async run(@Inject(Hash) hash?: Hash): Promise<string> {
        return hash?.name() ?? 'none'
      }
    }
    container
      .when(Handler)
      .asksFor(Hash)
      .provide(() => new Argon2())

    expect(await container.call(new Handler(), 'run')).toBe('argon2')
  })

  it('resolveFor answers as if that class had asked', async () => {
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => new Argon2())

    expect((await container.resolveFor<Hash>(UsersController, Hash)).name()).toBe('argon2')
    // null parent means nobody asked — the container binding.
    expect((await container.resolveFor<Hash>(null, Hash)).name()).toBe('bcrypt')
  })

  it('is reachable from a per-request resolver', async () => {
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => new Argon2())
    const resolver = container.createResolver()

    expect((await resolver.make<UsersController>(UsersController)).hash.name()).toBe('argon2')
    expect((await resolver.resolveFor<Hash>(UsersController, Hash)).name()).toBe('argon2')
  })

  it('does not leak the parent past the construction that set it', async () => {
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => new Argon2())
    await container.make<UsersController>(UsersController)

    // The chain is over; a fresh resolution must not still think it is inside
    // UsersController.
    expect((await container.make<Hash>(Hash)).name()).toBe('bcrypt')
  })
})

/**
 * A failed `call()` must not leave its class installed as the resolution parent.
 *
 * The restore was not in a `finally`, so a parameter that failed to resolve —
 * with the caller catching the error — left the called class as the parent of
 * every later resolution. A contextual binding meant for one handler then
 * applied to the whole application, silently and for good.
 */
describe('container > the resolution parent after a failed call()', () => {
  class Global {}
  class Boom {}
  class Handler {
    async run(@Inject(Boom) _dep?: Boom): Promise<void> {}
  }

  it('restores the previous parent when a parameter throws', async () => {
    // The leak only shows from INSIDE a resolution: at the top level `call()`
    // opens its own chain and discards it. A factory that calls into a handler,
    // catches the failure and carries on is where the mutated parent survived.
    const container = new Container()
    container.singleton(Global, () => ({ from: 'global' }))
    container.singleton(Boom, () => {
      throw new Error('this dependency cannot be built')
    })
    // Reserved for Handler, and for nothing else.
    container.contextualBinding(Handler, Global, () => ({ from: 'handler' }))

    container.singleton('probe', async (c) => {
      try {
        await c.call(new Handler(), 'run')
      } catch {
        // Swallowed on purpose — this is the shape that leaked.
      }
      // `make`, not `resolve`: a factory is handed a FactoryResolver, and the
      // per-request resolver that also satisfies it has no `resolve`. They are
      // the same call — `Container.make` delegates straight to it.
      return c.make<{ from: string }>(Global)
    })

    // Resolved after the failed call, still inside the same chain: it must get
    // the global binding, not the one reserved for the handler.
    expect(await container.resolve<{ from: string }>('probe')).toEqual({
      from: 'global',
    })
  })
})

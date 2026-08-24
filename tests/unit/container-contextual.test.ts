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

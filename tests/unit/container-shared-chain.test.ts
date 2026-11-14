import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container, Inject, Service } from '../../src/index.js'

/**
 * Concurrent resolutions INSIDE one open chain.
 *
 * `container-concurrent-resolve.test.ts` covers chains that each start at the
 * top. A chain can also be opened around a whole body — `container.call()`
 * opens one for a command's `run()`, `resolveFor` and `runWithScopedValues`
 * one for whatever they wrap — and everything resolved inside it, in every
 * concurrent task, used to share that one mutable stack. Two tasks asking for
 * the same singleton at once read as `catalog → catalog`: measured in an
 * application whose nightly command folds several instruments in parallel,
 * where it failed one job and left its holders' positions unfolded.
 *
 * The parent a contextual binding keys on lived on the same shared object, so
 * one task's construction could see another's class as its parent.
 */

/** Yields to the event loop before answering, like a binding that does I/O. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('Container — concurrent resolution inside one chain', () => {
  it('does not report a cycle for the same singleton asked twice at once in a command', async () => {
    const container = new Container()
    container.singleton('catalog', async () => {
      await tick()
      return { name: 'catalog' }
    })
    class Command {
      run() {
        return Promise.all([container.make('catalog'), container.make('catalog')])
      }
    }

    const [first, second] = (await container.call(new Command(), 'run')) as unknown[]

    expect(first).toEqual({ name: 'catalog' })
    expect(second).toBe(first)
  })

  it('does not report a cycle for a factory that resolves one token twice at once', async () => {
    const container = new Container()
    container.singleton('leaf', async () => {
      await tick()
      return 'leaf'
    })
    container.singleton('root', async () =>
      Promise.all([container.resolve('leaf'), container.resolve('leaf')]),
    )

    expect(await container.resolve('root')).toEqual(['leaf', 'leaf'])
  })

  it('does not report a cycle for sibling chains sharing a dependency under resolveFor', async () => {
    const container = new Container()
    class Owner {}
    container.singleton('shared', async () => {
      await tick()
      return 'shared'
    })
    container.singleton('left', async () => `left:${await container.resolve('shared')}`)
    container.singleton('right', async () => `right:${await container.resolve('shared')}`)

    const both = await container
      .resolveFor(Owner, 'shared')
      .then(() =>
        container.runWithScopedValues(new Map(), () =>
          Promise.all([container.resolve('left'), container.resolve('right')]),
        ),
      )

    expect(both).toEqual(['left:shared', 'right:shared'])
  })

  it('still catches a real cycle inside a command', async () => {
    const container = new Container()
    container.singleton('a', async () => container.resolve('b'))
    container.singleton('b', async () => container.resolve('a'))
    class Command {
      run() {
        return container.make('a')
      }
    }

    await expect(container.call(new Command(), 'run')).rejects.toThrow(
      /Circular dependency detected: a → b → a/,
    )
  })

  it('keeps each concurrent construction on its own parent for contextual bindings', async () => {
    abstract class Hash {
      abstract name(): string
    }
    @Service({ scope: 'transient' })
    class UsersController {
      constructor(
        @Inject('slow') readonly slow: string,
        @Inject(Hash) readonly hash: Hash,
      ) {}
    }
    @Service({ scope: 'transient' })
    class SessionsController {
      constructor(
        @Inject('slower') readonly slower: string,
        @Inject(Hash) readonly hash: Hash,
      ) {}
    }
    const container = new Container()
    container.bind('slow', async () => {
      await tick()
      return 'slow'
    })
    // Longer, so the sessions controller is still mid-build, its class set as
    // the parent, when the users controller asks for its hash.
    container.bind('slower', async () => {
      await tick()
      await tick()
      await tick()
      return 'slower'
    })
    container.bind(Hash, () => ({ name: () => 'bcrypt' }))
    container
      .when(UsersController)
      .asksFor(Hash)
      .provide(() => ({ name: () => 'argon2' }))
    class Command {
      run() {
        return Promise.all([
          container.make<UsersController>(UsersController),
          container.make<SessionsController>(SessionsController),
        ])
      }
    }

    const [users, sessions] = (await container.call(new Command(), 'run')) as [
      UsersController,
      SessionsController,
    ]

    expect(users.hash.name()).toBe('argon2')
    expect(sessions.hash.name()).toBe('bcrypt')
  })
})

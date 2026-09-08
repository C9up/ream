/**
 * The migration registry.
 *
 * A REAM PARTICULARITY — AdonisJS has no equivalent, because Lucid is its only
 * migration source and `migration:run` can name it. Ream expects several stores
 * in one app, so the CLI must name none of them.
 *
 * The behaviours pinned here are the ones that fail SILENTLY when wrong: a
 * duplicate name would leave one store un-migrated while the run still reported
 * success, and an empty registry has to stay distinguishable from a missing
 * binding — the CLI says something different in each case.
 */
import { describe, expect, it } from 'vitest'
import { MigrationRegistry } from '../../src/migrations/MigrationRegistry.js'
import type { MigrationRunnerContract } from '../../src/migrations/types.js'

/** A runner that records what was asked of it. */
function stubRunner(overrides: Partial<MigrationRunnerContract> = {}): MigrationRunnerContract {
  return {
    async migrate() {
      return []
    },
    async rollback() {
      return []
    },
    async status() {
      return []
    },
    ...overrides,
  }
}

describe('MigrationRegistry', () => {
  it('starts empty, which is not the same as absent', () => {
    const registry = new MigrationRegistry()
    expect(registry.isEmpty).toBe(true)
    expect(registry.all()).toEqual([])
    expect(registry.names()).toEqual([])
  })

  it('keeps registration order, so output is stable run to run', () => {
    const registry = new MigrationRegistry()
      .register({ name: 'atlas', runner: stubRunner() })
      .register({ name: 'eon', runner: stubRunner() })

    expect(registry.names()).toEqual(['atlas', 'eon'])
  })

  it('refuses a duplicate name instead of replacing it', () => {
    const registry = new MigrationRegistry().register({ name: 'atlas', runner: stubRunner() })

    // Replacing silently would leave one provider's store un-migrated while
    // `ream migrate` still exited 0 — the worst possible outcome.
    expect(() => registry.register({ name: 'atlas', runner: stubRunner() })).toThrow(
      /already registered/,
    )
    expect(registry.all()).toHaveLength(1)
  })

  it('looks a source up by name, and says nothing rather than guessing', () => {
    const registry = new MigrationRegistry().register({ name: 'eon', runner: stubRunner() })

    expect(registry.get('eon')?.name).toBe('eon')
    expect(registry.get('atlas')).toBeUndefined()
  })

  it('carries the directory, so a CLI message can name where files go', () => {
    const registry = new MigrationRegistry().register({
      name: 'eon',
      directory: 'database/eon-migrations',
      runner: stubRunner(),
    })
    expect(registry.get('eon')?.directory).toBe('database/eon-migrations')
  })

  it('a runner needs only the three methods the CLI calls', async () => {
    // The optional ones are optional ON PURPOSE: a new store must be able to
    // register a runner that only knows how to go forward, rather than stub
    // methods it cannot honour.
    const registry = new MigrationRegistry().register({
      name: 'minimal',
      runner: stubRunner({
        async migrate() {
          return ['0001_init']
        },
      }),
    })

    const source = registry.get('minimal')
    expect(await source?.runner.migrate()).toEqual(['0001_init'])
    expect(source?.runner.fresh).toBeUndefined()
    expect(source?.runner.forceUnlock).toBeUndefined()
  })
})

/**
 * A provider that shuts down has to give its name back.
 *
 * `register` refuses a duplicate on purpose — two providers claiming one name
 * means one migrates nothing while the run reports success. But nothing ever
 * removed a source, so a provider that shut down left its name taken and its
 * runner holding a connection it had already closed. A second boot in the same
 * process — a hot reload, a test that restarts the app — failed on "already
 * registered", and the CLI would have driven a runner pointing at a dead pool.
 */
describe('migration registry > giving a name back', () => {
  const source = (name: string) =>
    ({ name, run: async () => {}, rollback: async () => {} }) as never

  it('lets the same name be registered again after it is released', () => {
    const registry = new MigrationRegistry()
    const first = source('atlas')
    registry.register(first)

    expect(registry.unregister('atlas', first)).toBe(true)

    expect(() => registry.register(source('atlas'))).not.toThrow()
  })

  it('refuses to release another owner’s registration', () => {
    // Two applications can share a process; the one shutting down must not
    // unregister the survivor's runner because the name matches.
    const registry = new MigrationRegistry()
    const theirs = source('atlas')
    registry.register(theirs)

    expect(registry.unregister('atlas', source('atlas'))).toBe(false)
    expect(registry.get('atlas')).toBe(theirs)
  })

  it('releases by name when no owner is named', () => {
    const registry = new MigrationRegistry()
    registry.register(source('eon'))

    expect(registry.unregister('eon')).toBe(true)
    expect(registry.isEmpty).toBe(true)
  })

  it('says so when there was nothing to release', () => {
    expect(new MigrationRegistry().unregister('nothing')).toBe(false)
  })
})

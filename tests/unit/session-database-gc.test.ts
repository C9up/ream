/**
 * Expired session rows have to be collected.
 *
 * `DatabaseDriver` shipped a `prune()` whose own comment said "for a scheduled
 * job, since nothing else does" — and nothing did. `read()` only drops a row it
 * happens to look at, so a session whose owner never comes back stayed in the
 * table forever. AdonisJS sweeps probabilistically on write (`gcProbability`,
 * 2% by default); ream did not accept the option at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseDriver } from '../../src/session/drivers/DatabaseDriver.js'

function fakeDb() {
  const executed: string[] = []
  return {
    executed,
    connection: {
      query: async () => [],
      execute: async (sql: string) => {
        executed.push(sql)
        // No row matched the UPDATE, so write() falls through to the INSERT.
        return { rowsAffected: sql.startsWith('UPDATE') ? 0 : 1 }
      },
    },
  }
}

const sweeps = (executed: string[]): number =>
  executed.filter((sql) => sql.includes('DELETE') && sql.includes('expires_at <')).length

afterEach(() => vi.restoreAllMocks())

describe('session > database garbage collection', () => {
  it('sweeps when the draw comes up under the probability', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const db = fakeDb()

    await new DatabaseDriver({ connection: db.connection }).write('s1', {}, 60)

    expect(sweeps(db.executed)).toBe(1)
  })

  it('does not sweep on the other 98 writes', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const db = fakeDb()

    await new DatabaseDriver({ connection: db.connection }).write('s1', {}, 60)

    expect(sweeps(db.executed)).toBe(0)
  })

  it('sweeps on the UPDATE path too, not only on INSERT', async () => {
    // A returning visitor updates their row; without this, an app whose users
    // all have sessions already would never sweep at all.
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const executed: string[] = []
    const driver = new DatabaseDriver({
      connection: {
        query: async () => [],
        execute: async (sql: string) => {
          executed.push(sql)
          return { rowsAffected: 1 }
        },
      },
    })

    await driver.write('s1', {}, 60)

    expect(executed.some((sql) => sql.startsWith('INSERT'))).toBe(false)
    expect(sweeps(executed)).toBe(1)
  })

  it('honours a custom probability', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 50 on the 0-100 scale
    const never = fakeDb()
    const always = fakeDb()

    await new DatabaseDriver({ connection: never.connection, gcProbability: 40 }).write('s', {}, 60)
    await new DatabaseDriver({ connection: always.connection, gcProbability: 60 }).write(
      's',
      {},
      60,
    )

    expect(sweeps(never.executed)).toBe(0)
    expect(sweeps(always.executed)).toBe(1)
  })

  it('never sweeps at 0, for a deployment that prunes on a schedule', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const db = fakeDb()

    await new DatabaseDriver({ connection: db.connection, gcProbability: 0 }).write('s', {}, 60)

    expect(sweeps(db.executed)).toBe(0)
  })

  it('refuses a probability that is not a percentage', () => {
    for (const gcProbability of [-1, 101, Number.NaN]) {
      expect(() => new DatabaseDriver({ connection: fakeDb().connection, gcProbability })).toThrow(
        /between 0 and 100/,
      )
    }
  })

  it('writes the session even when the sweep fails', async () => {
    // The request needed its session stored; a failed cleanup is not its problem.
    vi.spyOn(Math, 'random').mockReturnValue(0.001)
    let wrote = false
    const driver = new DatabaseDriver({
      connection: {
        query: async () => [],
        execute: async (sql: string) => {
          if (sql.startsWith('DELETE')) throw new Error('table locked')
          if (sql.startsWith('INSERT')) wrote = true
          return { rowsAffected: sql.startsWith('UPDATE') ? 0 : 1 }
        },
      },
    })

    await expect(driver.write('s1', {}, 60)).resolves.toBeUndefined()
    expect(wrote).toBe(true)
  })
})

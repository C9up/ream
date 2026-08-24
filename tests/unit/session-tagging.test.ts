/**
 * Session tagging — AdonisJS `session.tag()` / `untag()`.
 *
 * This is what "log out from all my devices" and "your active sessions" are
 * built on: a session is associated with a user at login, so every session that
 * user holds can be found and destroyed later. ream had no equivalent at all,
 * which made the feature unbuildable rather than merely awkward.
 */

import { describe, expect, it } from 'vitest'
import { CookieDriver } from '../../src/session/drivers/CookieDriver.js'
import { DatabaseDriver } from '../../src/session/drivers/DatabaseDriver.js'
import { MemoryDriver } from '../../src/session/drivers/MemoryDriver.js'
import { RedisDriver } from '../../src/session/drivers/RedisDriver.js'
import { Session, supportsTagging } from '../../src/session/Session.js'

const TTL = 3600

function sessionOn(driver: MemoryDriver, id = 'sess-1'): Session {
  const session = new Session(id)
  session.setDriver(driver, true)
  return session
}

describe('session > tagging on the memory store', () => {
  it('finds every session a user holds', async () => {
    const driver = new MemoryDriver()
    await driver.write('phone', { device: 'phone' }, TTL)
    await driver.write('laptop', { device: 'laptop' }, TTL)
    await driver.tag('phone', 42)
    await driver.tag('laptop', 42)

    const sessions = await driver.tagged(42)

    expect(sessions.map((s) => s.id).sort()).toEqual(['laptop', 'phone'])
    expect(sessions.find((s) => s.id === 'phone')?.data).toEqual({ device: 'phone' })
  })

  it('supports logging out everywhere', async () => {
    // The whole point: find them, destroy them, and the user is out.
    const driver = new MemoryDriver()
    for (const id of ['a', 'b', 'c']) {
      await driver.write(id, {}, TTL)
      await driver.tag(id, 'u1')
    }

    for (const { id } of await driver.tagged('u1')) await driver.destroy(id)

    expect(await driver.tagged('u1')).toEqual([])
  })

  it('keeps one user out of another user list', async () => {
    const driver = new MemoryDriver()
    await driver.write('mine', {}, TTL)
    await driver.write('theirs', {}, TTL)
    await driver.tag('mine', 'u1')
    await driver.tag('theirs', 'u2')

    expect((await driver.tagged('u1')).map((s) => s.id)).toEqual(['mine'])
  })

  it('drops the tag when the session is destroyed', async () => {
    // A destroyed session left in the index would be reported as an active
    // device forever.
    const driver = new MemoryDriver()
    await driver.write('gone', {}, TTL)
    await driver.tag('gone', 'u1')

    await driver.destroy('gone')

    expect(await driver.tagged('u1')).toEqual([])
  })

  it('forgets an expired session rather than list it', async () => {
    const driver = new MemoryDriver()
    await driver.write('stale', {}, -1)
    await driver.tag('stale', 'u1')

    expect(await driver.tagged('u1')).toEqual([])
  })

  it('untag removes only that association', async () => {
    const driver = new MemoryDriver()
    await driver.write('a', {}, TTL)
    await driver.write('b', {}, TTL)
    await driver.tag('a', 'u1')
    await driver.tag('b', 'u1')

    await driver.untag('a', 'u1')

    expect((await driver.tagged('u1')).map((s) => s.id)).toEqual(['b'])
  })

  it('returns nothing for a user who never logged in', async () => {
    expect(await new MemoryDriver().tagged('nobody')).toEqual([])
  })
})

describe('session > tagging through the Session API', () => {
  it('tags the current session id', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', { a: 1 }, TTL)
    const session = sessionOn(driver)

    await session.tag('u1')

    expect((await driver.tagged('u1')).map((s) => s.id)).toEqual(['sess-1'])
  })

  it('untags it', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', {}, TTL)
    const session = sessionOn(driver)
    await session.tag('u1')

    await session.untag('u1')

    expect(await driver.tagged('u1')).toEqual([])
  })

  it('reports whether the store can tag at all', () => {
    const tagging = new Session('x')
    tagging.setDriver(new MemoryDriver(), true)
    const plain = new Session('x')
    plain.setDriver(new CookieDriver('a-secret-long-enough-for-the-driver'), true)

    expect(tagging.supportsTagging()).toBe(true)
    expect(plain.supportsTagging()).toBe(false)
  })

  it('throws on a store that cannot tag, rather than doing nothing', async () => {
    // A login that believes it tagged the session would leave "log out
    // everywhere" silently logging nobody out.
    const session = new Session('x')
    session.setDriver(new CookieDriver('a-secret-long-enough-for-the-driver'), true)

    await expect(session.tag('u1')).rejects.toThrow(/not supported/)
  })

  it('throws when the session has no store at all', async () => {
    await expect(new Session('x').tag('u1')).rejects.toThrow(/needs a session store/)
  })
})

describe('session > supportsTagging(driver)', () => {
  it('recognises the stores that can, and only those', () => {
    expect(supportsTagging(new MemoryDriver())).toBe(true)
    expect(supportsTagging(new RedisDriver({ get: async () => null } as never))).toBe(true)
    expect(
      supportsTagging(
        new DatabaseDriver({
          connection: { query: async () => [], execute: async () => ({ rowsAffected: 0 }) },
        }),
      ),
    ).toBe(true)
    expect(supportsTagging(new CookieDriver('a-secret-long-enough-for-the-driver'))).toBe(false)
  })
})

describe('session > tagging on the database store', () => {
  function fakeDb() {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    return {
      executed,
      connection: {
        query: async () => [{ id: 'sess-1', data: '{"a":1}' }],
        execute: async (sql: string, params?: unknown[]) => {
          executed.push({ sql, params: params ?? [] })
          return { rowsAffected: 1 }
        },
      },
    }
  }

  it('sets user_id at login', async () => {
    const db = fakeDb()
    await new DatabaseDriver({ connection: db.connection }).tag('sess-1', 7)

    expect(db.executed[0].sql).toContain('SET user_id = ?')
    expect(db.executed[0].params).toEqual(['7', 'sess-1'])
  })

  it('scopes untag to the user, so it cannot clear another one', async () => {
    const db = fakeDb()
    await new DatabaseDriver({ connection: db.connection }).untag('sess-1', 7)

    expect(db.executed[0].sql).toContain('AND user_id = ?')
  })

  it('lists only non-expired sessions', async () => {
    const driver = new DatabaseDriver({
      connection: {
        query: async (sql: string) => {
          expect(sql).toContain('expires_at >= ?')
          return [{ id: 'sess-1', data: '{"a":1}' }]
        },
        execute: async () => ({ rowsAffected: 0 }),
      },
    })

    expect(await driver.tagged(7)).toEqual([{ id: 'sess-1', data: { a: 1 } }])
  })
})

describe('session > state getters (AdonisJS parity)', () => {
  it('reports a session created for this request as fresh', () => {
    const incoming = new Session('x', { a: 1 })
    incoming.setDriver(new MemoryDriver(), false)
    const created = new Session('y')
    created.setDriver(new MemoryDriver(), true)

    expect(incoming.fresh).toBe(false)
    expect(created.fresh).toBe(true)
  })

  it('reports emptiness, flash data included', () => {
    expect(new Session('x').isEmpty).toBe(true)
    expect(new Session('x', { a: 1 }).isEmpty).toBe(false)

    // A session carrying only a flash message still has something to write.
    const flashed = new Session('x')
    flashed.flash('notice', 'Saved')
    expect(flashed.isEmpty).toBe(false)
  })

  it('exposes hasBeenModified alongside isDirty', () => {
    const session = new Session('x')
    expect(session.hasBeenModified).toBe(false)

    session.put('a', 1)

    expect(session.hasBeenModified).toBe(true)
    expect(session.isDirty()).toBe(true)
  })

  it('reports readonly as false, because ream has no read-only mode', () => {
    // Saying true would tell a caller its writes were dropped when they were not.
    expect(new Session('x').readonly).toBe(false)
  })
})

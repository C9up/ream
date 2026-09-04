/**
 * AdonisJS ships six session stores; ream had three. `file` survives a restart
 * without a Redis; `database` is what several instances sharing one database
 * need — neither memory nor file can do that.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseDriver } from '../../src/session/drivers/DatabaseDriver.js'
import { FileDriver } from '../../src/session/drivers/FileDriver.js'
import { defined } from '../__helpers__/defined.js'

describe('ream > file session driver', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-sessions-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a session across instances', async () => {
    await new FileDriver({ location: dir }).write('sid', { user: 1 }, 3600)
    // A second instance reads what the first wrote — the point of the store.
    expect(await new FileDriver({ location: dir }).read('sid')).toEqual({
      user: 1,
    })
  })

  it('never uses the session id as a filename', async () => {
    const driver = new FileDriver({ location: dir })
    // The id comes from a cookie: `../../` must not choose the path.
    await driver.write('../../escaped', { a: 1 }, 3600)
    expect(fs.existsSync(path.join(dir, '..', '..', 'escaped.json'))).toBe(false)
    expect(fs.readdirSync(dir)).toHaveLength(1)
    expect(await driver.read('../../escaped')).toEqual({ a: 1 })
  })

  it('treats an expired session as absent', async () => {
    const driver = new FileDriver({ location: dir })
    await driver.write('sid', { user: 1 }, -1)
    expect(await driver.read('sid')).toBe(null)
  })

  it('treats an unreadable file as absent rather than half-parsing it', async () => {
    const driver = new FileDriver({ location: dir })
    await driver.write('sid', { user: 1 }, 3600)
    const [file] = fs.readdirSync(dir)
    fs.writeFileSync(path.join(dir, defined(file)), '{"data":{"user"')
    expect(await driver.read('sid')).toBe(null)
  })

  it('destroys and touches', async () => {
    const driver = new FileDriver({ location: dir })
    await driver.write('sid', { user: 1 }, 3600)
    await driver.touch('sid', 7200)
    expect(await driver.read('sid')).toEqual({ user: 1 })
    await driver.destroy('sid')
    expect(await driver.read('sid')).toBe(null)
  })
})

/** An in-memory stand-in for the two methods the store needs. */
function fakeDb() {
  const rows = new Map<string, { data: string; expires_at: number }>()
  return {
    rows,
    sql: [] as string[],
    query: async (_sql: string, params: unknown[] = []) => {
      const row = rows.get(String(params[0]))
      return row ? [row] : []
    },
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE')) {
        const id = String(params[2] ?? params[1])
        const row = rows.get(id)
        if (!row) return { rowsAffected: 0 }
        if (sql.includes('data = ?')) {
          rows.set(id, { data: String(params[0]), expires_at: Number(params[1]) })
        } else {
          rows.set(id, { ...row, expires_at: Number(params[0]) })
        }
        return { rowsAffected: 1 }
      }
      if (sql.startsWith('INSERT')) {
        rows.set(String(params[0]), {
          data: String(params[1]),
          expires_at: Number(params[2]),
        })
        return { rowsAffected: 1 }
      }
      if (sql.startsWith('DELETE')) {
        rows.delete(String(params[0]))
        return { rowsAffected: 1 }
      }
      return { rowsAffected: 0 }
    },
  }
}

describe('ream > database session driver', () => {
  it('inserts, then updates in place', async () => {
    const db = fakeDb()
    const driver = new DatabaseDriver({ connection: db })
    await driver.write('sid', { user: 1 }, 3600)
    await driver.write('sid', { user: 2 }, 3600)
    expect(db.rows.size).toBe(1)
    expect(await driver.read('sid')).toEqual({ user: 2 })
  })

  it('treats an expired row as absent and clears it', async () => {
    const db = fakeDb()
    const driver = new DatabaseDriver({ connection: db })
    await driver.write('sid', { user: 1 }, -1)
    expect(await driver.read('sid')).toBe(null)
    expect(db.rows.size).toBe(0)
  })

  it('refuses a table name that is not a plain identifier', () => {
    // The table is concatenated into the SQL — it cannot be a bind parameter.
    expect(
      () => new DatabaseDriver({ connection: fakeDb(), tableName: 's; DROP TABLE users' }),
    ).toThrow(/not a plain identifier/)
  })

  it('destroys a session', async () => {
    const db = fakeDb()
    const driver = new DatabaseDriver({ connection: db })
    await driver.write('sid', { user: 1 }, 3600)
    await driver.destroy('sid')
    expect(await driver.read('sid')).toBe(null)
  })
})

import type { SessionDriver } from '../Session.js'

/**
 * The little a session store needs of a database connection.
 *
 * Structural on purpose: ream must not import atlas to store a session, so any
 * connection exposing these two methods works — atlas, a test double, or an
 * app's own wrapper.
 */
export interface SessionDbConnection {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>
}

export interface DatabaseDriverOptions {
  connection: SessionDbConnection
  /** Table holding the sessions. Default `sessions`. */
  tableName?: string
}

/**
 * Database-backed sessions (AdonisJS `database` store).
 *
 * The fit is several app instances sharing one database and no Redis: every
 * instance reads the same sessions, which neither the memory nor the file store
 * can do.
 *
 * The table it expects:
 *
 *   id          varchar primary key
 *   data        text
 *   expires_at  bigint     -- epoch ms
 */
export class DatabaseDriver implements SessionDriver {
  readonly #db: SessionDbConnection
  readonly #table: string

  constructor(options: DatabaseDriverOptions) {
    this.#db = options.connection
    const table = options.tableName ?? 'sessions'
    // The table name is concatenated into the SQL (it cannot be a bind
    // parameter), so it is restricted to an identifier rather than trusted.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(
        `Session table name "${table}" is not a plain identifier — letters, digits and underscores only.`,
      )
    }
    this.#table = table
  }

  async read(sessionId: string): Promise<Record<string, unknown>> {
    const rows = await this.#db.query<{ data: string; expires_at: number | string }>(
      `SELECT data, expires_at FROM ${this.#table} WHERE id = ?`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) return {}
    if (Number(row.expires_at) < Date.now()) {
      await this.destroy(sessionId)
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(row.data)
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      // Unreadable row: treat the session as absent rather than hand the app a
      // half-parsed object.
      return {}
    }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    const payload = JSON.stringify(data)
    const expiresAt = Date.now() + ttl * 1000
    // UPDATE-then-INSERT rather than a dialect-specific upsert: `ON CONFLICT`
    // and `ON DUPLICATE KEY` are spelled differently by each engine, and this
    // store has to work on all of them.
    const updated = await this.#db.execute(
      `UPDATE ${this.#table} SET data = ?, expires_at = ? WHERE id = ?`,
      [payload, expiresAt, sessionId],
    )
    if (updated.rowsAffected > 0) return
    await this.#db.execute(`INSERT INTO ${this.#table} (id, data, expires_at) VALUES (?, ?, ?)`, [
      sessionId,
      payload,
      expiresAt,
    ])
  }

  async destroy(sessionId: string): Promise<void> {
    await this.#db.execute(`DELETE FROM ${this.#table} WHERE id = ?`, [sessionId])
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    await this.#db.execute(`UPDATE ${this.#table} SET expires_at = ? WHERE id = ?`, [
      Date.now() + ttl * 1000,
      sessionId,
    ])
  }

  /** Delete every expired row — for a scheduled job, since nothing else does. */
  async prune(): Promise<void> {
    await this.#db.execute(`DELETE FROM ${this.#table} WHERE expires_at < ?`, [Date.now()])
  }
}

import type { SessionDriverWithTagging, TaggedSession } from '../Session.js'

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
 *   user_id     varchar null  -- session tagging; nullable, only set at login
 */
export class DatabaseDriver implements SessionDriverWithTagging {
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
    return parseData(row.data)
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

  /**
   * Associate the session with a user (AdonisJS's database store does the same:
   * a nullable `user_id` column, set at login).
   */
  async tag(sessionId: string, userId: string | number): Promise<void> {
    await this.#db.execute(`UPDATE ${this.#table} SET user_id = ? WHERE id = ?`, [
      String(userId),
      sessionId,
    ])
  }

  /**
   * Drop the association. Scoped to the user id as well as the session, so a
   * logout cannot clear a tag another user's session happens to hold.
   */
  async untag(sessionId: string, userId: string | number): Promise<void> {
    await this.#db.execute(
      `UPDATE ${this.#table} SET user_id = NULL WHERE id = ? AND user_id = ?`,
      [sessionId, String(userId)],
    )
  }

  /** Every non-expired session this user holds — their active devices. */
  async tagged(userId: string | number): Promise<TaggedSession[]> {
    const rows = await this.#db.query<{ id: string; data: string }>(
      `SELECT id, data FROM ${this.#table} WHERE user_id = ? AND expires_at >= ?`,
      [String(userId), Date.now()],
    )
    return rows.map((row) => ({ id: row.id, data: parseData(row.data) }))
  }

  /** Delete every expired row — for a scheduled job, since nothing else does. */
  async prune(): Promise<void> {
    await this.#db.execute(`DELETE FROM ${this.#table} WHERE expires_at < ?`, [Date.now()])
  }
}

/**
 * A stored payload back into an object. An unreadable row is an absent session
 * rather than a half-parsed object handed to the app.
 */
function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

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
  /**
   * Percent chance that a write also sweeps expired rows (AdonisJS
   * `gcProbability`, default 2).
   *
   * Without it nothing collects them: `read()` only drops a row it happens to
   * look at, so a session whose owner never comes back stays in the table
   * forever. `0` turns the sweep off, for a deployment that prunes on a
   * schedule instead — see {@link DatabaseDriver.prune}.
   */
  gcProbability?: number
}

/** AdonisJS's default: two writes in a hundred pay for the cleanup. */
const DEFAULT_GC_PROBABILITY = 2

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
  readonly #gcProbability: number

  constructor(options: DatabaseDriverOptions) {
    this.#db = options.connection
    const gc = options.gcProbability ?? DEFAULT_GC_PROBABILITY
    if (!Number.isFinite(gc) || gc < 0 || gc > 100) {
      throw new Error(
        `Session gcProbability must be a percentage between 0 and 100, got ${String(options.gcProbability)}.`,
      )
    }
    this.#gcProbability = gc
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

  async read(sessionId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.#db.query<{ data: string; expires_at: number | string }>(
      `SELECT data, expires_at FROM ${this.#table} WHERE id = ?`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) return null
    if (Number(row.expires_at) < Date.now()) {
      await this.destroy(sessionId)
      return null
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
    if (updated.rowsAffected > 0) {
      await this.#collectGarbage()
      return
    }
    await this.#db.execute(`INSERT INTO ${this.#table} (id, data, expires_at) VALUES (?, ?, ?)`, [
      sessionId,
      payload,
      expiresAt,
    ])
    await this.#collectGarbage()
  }

  /**
   * Sweep expired rows on a fraction of writes (AdonisJS `#collectGarbage`).
   *
   * Best-effort: a failed sweep must not fail the request that happened to draw
   * the short straw. What it did not remove, the next write that does will.
   */
  async #collectGarbage(): Promise<void> {
    if (this.#gcProbability <= 0) return
    if (Math.random() * 100 >= this.#gcProbability) return
    try {
      await this.prune()
    } catch {
      // See above — the session was written, which is what the request needed.
    }
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

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SessionDriver } from '../Session.js'

/**
 * File-backed sessions (AdonisJS `file` store) — one file per session id.
 *
 * The fit is a single machine that must survive a restart without running a
 * Redis: the data outlives the process, which the memory store cannot offer.
 * It does NOT fit several machines, where each one would hold a different half
 * of the sessions.
 */
export interface FileDriverOptions {
  /** Directory the session files live in. Created if missing. */
  location: string
}

export class FileDriver implements SessionDriver {
  readonly #location: string

  constructor(options: FileDriverOptions) {
    this.#location = path.resolve(options.location)
    fs.mkdirSync(this.#location, { recursive: true })
  }

  /**
   * The file backing a session id.
   *
   * The id is HASHED, never used as a filename: it arrives from a cookie, so a
   * value like `../../etc/passwd` would otherwise choose the path. A hash also
   * keeps the name a fixed, filesystem-safe length whatever the id looks like.
   */
  #pathFor(sessionId: string): string {
    const name = createHash('sha256').update(sessionId).digest('hex')
    return path.join(this.#location, `${name}.json`)
  }

  async read(sessionId: string): Promise<Record<string, unknown> | null> {
    let raw: string
    try {
      raw = await fs.promises.readFile(this.#pathFor(sessionId), 'utf8')
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      const entry = parsed as { expiresAt?: number; data?: Record<string, unknown> }
      if (typeof entry.expiresAt === 'number' && entry.expiresAt < Date.now()) {
        await this.destroy(sessionId)
        return null
      }
      return entry.data ?? {}
    } catch {
      // A truncated or hand-edited file is a session we cannot trust; treat it
      // as absent rather than handing a half-parsed object to the app.
      return null
    }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    const file = this.#pathFor(sessionId)
    const payload = JSON.stringify({ expiresAt: Date.now() + ttl * 1000, data })
    // Written to a temporary neighbour then renamed: a crash mid-write would
    // otherwise leave a truncated file, and the user would be silently logged
    // out. `rename` within one directory is atomic.
    const temp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(temp, file)
  }

  async destroy(sessionId: string): Promise<void> {
    await fs.promises.rm(this.#pathFor(sessionId), { force: true })
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    const data = await this.read(sessionId)
    // Nothing stored: there is no expiry to slide, and writing here would
    // create the very session that was not there.
    if (data === null || Object.keys(data).length === 0) return
    await this.write(sessionId, data, ttl)
  }
}

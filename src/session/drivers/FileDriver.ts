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

/** How long a writer waits for a session's lock before giving up. */
const LOCK_WAIT_MS = 2000
/**
 * A lock older than this was left by a process that died holding it. Every
 * operation under the lock is one small file read or write, far below it.
 */
const LOCK_STALE_MS = 10_000

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === code
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
    return this.#read(sessionId, () => this.destroy(sessionId))
  }

  /**
   * Read, dropping an expired file through `drop`: `destroy()` from outside,
   * a bare removal from inside the lock, which is already held there.
   */
  async #read(
    sessionId: string,
    drop: () => Promise<void>,
  ): Promise<Record<string, unknown> | null> {
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
        await drop()
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
    await this.#locked(sessionId, () => this.#replace(sessionId, data, ttl))
  }

  /**
   * Written only while the file is still there. A filesystem has no
   * conditional write, so every change to a session's file — this, `write`,
   * `destroy` and `touch` — runs under that session's lock: a `destroy` from a
   * logout cannot land between the check and the write, in this process or in
   * another one sharing the directory.
   */
  async update(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<boolean> {
    return this.#locked(sessionId, async () => {
      if ((await this.#read(sessionId, () => this.#remove(sessionId))) === null) return false
      await this.#replace(sessionId, data, ttl)
      return true
    })
  }

  async destroy(sessionId: string): Promise<void> {
    await this.#locked(sessionId, () => this.#remove(sessionId))
  }

  async #remove(sessionId: string): Promise<void> {
    await fs.promises.rm(this.#pathFor(sessionId), { force: true })
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    await this.#locked(sessionId, async () => {
      const data = await this.#read(sessionId, () => this.#remove(sessionId))
      // Nothing stored: there is no expiry to slide, and writing here would
      // create the very session that was not there.
      if (data === null || Object.keys(data).length === 0) return
      await this.#replace(sessionId, data, ttl)
    })
  }

  async #replace(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    const file = this.#pathFor(sessionId)
    const payload = JSON.stringify({ expiresAt: Date.now() + ttl * 1000, data })
    // Written to a temporary neighbour then renamed: a crash mid-write would
    // otherwise leave a truncated file, and the user would be silently logged
    // out. `rename` within one directory is atomic.
    const temp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(temp, file)
  }

  /**
   * Run `fn` holding the session's lock: a directory beside its file, which
   * `mkdir` creates atomically or refuses — the one exclusive primitive every
   * filesystem gives, across processes too.
   */
  async #locked<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.#pathFor(sessionId)}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await fs.promises.mkdir(lock)
        break
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
        const held = await fs.promises.stat(lock).catch(() => null)
        if (held !== null && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
          await fs.promises.rm(lock, { recursive: true, force: true })
          continue
        }
        if (Date.now() > deadline) {
          throw new Error(`Session file is locked: ${lock}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try {
      return await fn()
    } finally {
      await fs.promises.rmdir(lock).catch(() => {})
    }
  }
}

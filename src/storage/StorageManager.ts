/**
 * Storage — file storage abstraction with driver pattern.
 *
 * @implements MISS-24
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Resolve `filePath` against `root` and reject any result that escapes
 * the storage root. Without this guard a user-controlled path like
 * `../secrets.env` would let put/get/delete/exists touch arbitrary
 * files outside the configured storage root.
 *
 * The lexical check (`path.resolve` + `startsWith`) catches the
 * `../` / absolute-path class. The realpath re-check catches the
 * symlink-escape class: a symlink planted under the root (or anywhere
 * else on the resolved path's chain) that points outside the root
 * would pass the lexical gate but be caught here.
 *
 * We canonicalize the longest existing ancestor of `full` — `realpath`
 * itself throws ENOENT on a target that doesn't exist yet (the `put`
 * happy-path for new files). Symlinks anywhere ABOVE the leaf are
 * still dereferenced, which is the only escape vector that matters:
 * the driver creates the leaf itself, so no symlink can pre-exist
 * there.
 */
function assertWithinRoot(root: string, filePath: string): string {
  const full = path.resolve(root, filePath)
  const rootAbs = path.resolve(root)
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
    throw new Error(`[ream-storage] path '${filePath}' escapes the storage root (E_PATH_TRAVERSAL)`)
  }
  const canonicalRoot = fs.existsSync(rootAbs) ? fs.realpathSync(rootAbs) : rootAbs
  const ancestor = longestExistingAncestor(full)
  const canonicalAncestor = ancestor === full ? fs.realpathSync(full) : fs.realpathSync(ancestor)
  // Re-attach the not-yet-existing leaf to the canonicalized ancestor.
  const canonicalFull = canonicalAncestor + full.slice(ancestor.length)
  if (canonicalFull !== canonicalRoot && !canonicalFull.startsWith(canonicalRoot + path.sep)) {
    throw new Error(
      `[ream-storage] path '${filePath}' escapes the storage root via a symlink (E_PATH_TRAVERSAL)`,
    )
  }
  return full
}

/** Walk up `full` until we find a path that exists on disk. */
function longestExistingAncestor(full: string): string {
  let current = full
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

export interface StorageDriver {
  put(filePath: string, content: Buffer | string): Promise<void>
  get(filePath: string): Promise<Buffer | null>
  delete(filePath: string): Promise<boolean>
  exists(filePath: string): Promise<boolean>
  url(filePath: string): string
}

export class LocalDriver implements StorageDriver {
  #root: string

  constructor(root: string) {
    this.#root = root
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true })
    }
  }

  async put(filePath: string, content: Buffer | string): Promise<void> {
    const full = assertWithinRoot(this.#root, filePath)
    const dir = path.dirname(full)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(full, content)
  }

  async get(filePath: string): Promise<Buffer | null> {
    const full = assertWithinRoot(this.#root, filePath)
    if (!fs.existsSync(full)) return null
    return fs.readFileSync(full)
  }

  async delete(filePath: string): Promise<boolean> {
    const full = assertWithinRoot(this.#root, filePath)
    if (!fs.existsSync(full)) return false
    fs.unlinkSync(full)
    return true
  }

  async exists(filePath: string): Promise<boolean> {
    let full: string
    try {
      full = assertWithinRoot(this.#root, filePath)
    } catch {
      // exists() must NOT leak existence of out-of-root paths via the
      // thrown error — quietly report "no" for any traversal attempt.
      return false
    }
    return fs.existsSync(full)
  }

  url(filePath: string): string {
    return `/storage/${filePath}`
  }
}

export class StorageManager {
  #driver: StorageDriver

  constructor(driver: StorageDriver) {
    this.#driver = driver
  }

  put(filePath: string, content: Buffer | string): Promise<void> {
    return this.#driver.put(filePath, content)
  }

  get(filePath: string): Promise<Buffer | null> {
    return this.#driver.get(filePath)
  }

  delete(filePath: string): Promise<boolean> {
    return this.#driver.delete(filePath)
  }

  exists(filePath: string): Promise<boolean> {
    return this.#driver.exists(filePath)
  }

  url(filePath: string): string {
    return this.#driver.url(filePath)
  }
}

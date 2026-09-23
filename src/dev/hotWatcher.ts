/**
 * Watching the project for the changes a hot reload reacts to.
 *
 * ONE `fs.watch` PER DIRECTORY, walked ourselves — not `recursive: true`, and
 * never a watch on a file. That is not a preference, it is the bug this module
 * was reported for: most editors save by writing a temporary file and renaming
 * it over the original (JetBrains IDEs, several formatters, anything using
 * write-and-replace for crash safety). The rename gives the path a NEW inode,
 * and a watcher holding the old one is watching something that no longer has a
 * name. Measured on Node 25, Linux:
 *
 *     fs.watch(dir, { recursive: true })   first rename fires, then silence
 *     fs.watch(file)                       first rename fires, then silence
 *     fs.watch(dir)                        every rename fires
 *
 * So the first save hot-swapped and every one after it was ignored without a
 * word — no reload, no restart, nothing in the log. A directory keeps its inode
 * when a file inside it is replaced, which is why watching directories is the
 * form that survives. A file to watch is watched through its parent instead,
 * filtered by name.
 *
 * Two behaviours are worth stating because they are not obvious from the API:
 *
 * A save is rarely one event. Editors write, rename and touch, and a single
 * Ctrl-S can arrive as several notifications for the same file within a few
 * milliseconds. Each one would walk the graph and bump a version, so they are
 * coalesced.
 *
 * `ream dev` also watches from the outside, in Rust. That is not a duplicate:
 * this watcher dies with the process it lives in, so a server that crashed on a
 * syntax error has nothing left to notice the fix. The outer one covers exactly
 * that window, and hands back over by restarting the process.
 */

import { type FSWatcher, readdirSync, realpathSync, statSync, watch } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** How long to wait for a save to finish arriving before acting on it. */
const SETTLE_MS = 40

/** Never walked: none of it is application source, and some of it is enormous. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.wolf'])

/**
 * The half-written files an atomic save leaves behind for a few milliseconds.
 *
 * Reported, they would be a change to `Controller.ts.tmp8f3` — a file the graph
 * has never heard of, on its way to being renamed into the one that matters.
 */
function isEditorArtefact(name: string): boolean {
  return (
    name.endsWith('~') ||
    name.endsWith('.swp') ||
    name.endsWith('.swx') ||
    name.startsWith('.#') ||
    name.startsWith('.goutputstream') ||
    /\.tmp[\w-]*$/.test(name) ||
    /^\.?[\w.-]+\.(?:tmp|temp|crswap|part|partial)$/i.test(name)
  )
}

export interface WatcherOptions {
  /** Project root; every reported path is absolute, resolved against it. */
  root: string
  /** Directories under the root to watch, when they exist. */
  directories: readonly string[]
  /** Individual files to watch — env files sit at the root, so no directory covers them. */
  files: readonly string[]
  /** Called once per settled change, with an absolute path. */
  onChange: (file: string) => void
  /** Told when a directory could not be watched for a reason worth knowing. */
  onWarning?: (message: string) => void
}

export interface Watcher {
  close: () => void
}

export function watchProject(options: WatcherOptions): Watcher {
  const watchers = new Map<string, FSWatcher>()
  const pending = new Map<string, NodeJS.Timeout>()
  /** Real paths already walked, so a symlink loop cannot spin forever. */
  const visited = new Set<string>()
  let closed = false

  const report = (file: string): void => {
    const existing = pending.get(file)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      pending.delete(file)
      options.onChange(file)
    }, SETTLE_MS)
    // The dev server must still be able to exit while a save is settling.
    timer.unref?.()
    pending.set(file, timer)
  }

  const warn = (message: string): void => options.onWarning?.(message)

  /**
   * Watch one directory, then everything under it.
   *
   * Called again for a directory that appears later: a `mkdir app/billing`
   * during a session must be watched, and the parent's event is what says so.
   *
   * `announce` closes the gap between that mkdir and the watch being in place.
   * `mkdir -p app/billing && cp Controller.ts app/billing/` writes the file
   * before the watcher on the new directory exists, so what is already inside a
   * directory discovered mid-session is reported as a change. At startup it is
   * false, or booting would report every file in the project.
   */
  const watchDirectory = (absolute: string, announce = false): void => {
    if (closed || watchers.has(absolute)) return

    let real: string
    try {
      real = realpathSync(absolute)
      if (!statSync(real).isDirectory()) return
    } catch (error) {
      // Absent is ordinary — the list is the framework's conventional layout,
      // not a requirement, and a directory can be removed mid-session. Any
      // other reason (no permission, too many open files) is worth saying, or
      // the project silently stops hot-reloading.
      if (!isMissing(error)) warn(`cannot watch ${absolute}: ${describe(error)}`)
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    try {
      const watcher = watch(absolute, (_event, name) => {
        if (typeof name !== 'string' || name === '') return
        const child = join(absolute, name)
        // A new directory has to be picked up, or nothing in it is ever seen.
        // Cheap: only for names that are directories right now.
        if (!SKIP_DIRECTORIES.has(name) && isDirectory(child)) watchDirectory(child, true)
        if (isEditorArtefact(name)) return
        report(child)
      })
      watcher.on('error', (error) => {
        // A watcher whose directory was removed is done; anything else is a
        // surprise the developer should hear about rather than lose.
        watchers.delete(absolute)
        if (!isMissing(error)) warn(`watch on ${absolute} failed: ${describe(error)}`)
      })
      watchers.set(absolute, watcher)
    } catch (error) {
      if (!isMissing(error)) warn(`cannot watch ${absolute}: ${describe(error)}`)
      return
    }

    let entries: string[] = []
    try {
      entries = readdirSync(absolute)
    } catch (error) {
      if (!isMissing(error)) warn(`cannot read ${absolute}: ${describe(error)}`)
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const child = join(absolute, entry)
      if (isDirectory(child)) {
        watchDirectory(child, announce)
        continue
      }
      if (announce && !isEditorArtefact(entry)) report(child)
    }
  }

  for (const directory of options.directories) {
    watchDirectory(resolve(options.root, directory))
  }

  // A file is watched through its parent directory, for the reason at the top
  // of this module: `fs.watch` on the file itself holds an inode, and an atomic
  // save replaces it. `.env` is saved by the same editors as everything else.
  const watchedFiles = new Map<string, Set<string>>()
  for (const file of options.files) {
    const absolute = resolve(options.root, file)
    const parent = dirname(absolute)
    const names = watchedFiles.get(parent) ?? new Set<string>()
    names.add(basename(absolute))
    watchedFiles.set(parent, names)
  }

  for (const [parent, names] of watchedFiles) {
    // The parent may already be covered as a watched directory — `.env` sits at
    // the root, which is not in the list, but a caller is free to pass both.
    if (watchers.has(parent)) continue
    try {
      const watcher = watch(parent, (_event, name) => {
        if (typeof name !== 'string' || !names.has(name)) return
        report(join(parent, name))
      })
      watcher.on('error', (error) => {
        watchers.delete(parent)
        if (!isMissing(error)) warn(`watch on ${parent} failed: ${describe(error)}`)
      })
      watchers.set(parent, watcher)
    } catch (error) {
      if (!isMissing(error)) warn(`cannot watch ${parent}: ${describe(error)}`)
    }
  }

  return {
    close: () => {
      closed = true
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** ENOENT and friends: the path is simply not there, which is not a failure. */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

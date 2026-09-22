/**
 * Watching the project for the changes a hot reload reacts to.
 *
 * `fs.watch` with `recursive: true`, which Node implements on Linux, macOS and
 * Windows alike — the reason a watcher used to be a dependency here, and is not
 * any more.
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

import { type FSWatcher, watch } from 'node:fs'
import { join, resolve } from 'node:path'

/** How long to wait for a save to finish arriving before acting on it. */
const SETTLE_MS = 40

export interface WatcherOptions {
  /** Project root; every reported path is absolute, resolved against it. */
  root: string
  /** Directories under the root to watch, when they exist. */
  directories: readonly string[]
  /** Individual files to watch — env files sit at the root, so no directory covers them. */
  files: readonly string[]
  /** Called once per settled change, with an absolute path. */
  onChange: (file: string) => void
}

export interface Watcher {
  close: () => void
}

export function watchProject(options: WatcherOptions): Watcher {
  const watchers: FSWatcher[] = []
  const pending = new Map<string, NodeJS.Timeout>()

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

  for (const directory of options.directories) {
    const absolute = resolve(options.root, directory)
    try {
      watchers.push(
        watch(absolute, { recursive: true }, (_event, name) => {
          if (typeof name !== 'string' || name === '') return
          report(join(absolute, name))
        }),
      )
    } catch {
      // A directory this project does not have is not an error: the list is
      // the framework's conventional layout, not a requirement.
    }
  }

  for (const file of options.files) {
    const absolute = resolve(options.root, file)
    try {
      watchers.push(watch(absolute, () => report(absolute)))
    } catch {
      // Same: a `.env` that does not exist is simply not watched.
    }
  }

  return {
    close: () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      for (const watcher of watchers) watcher.close()
    },
  }
}

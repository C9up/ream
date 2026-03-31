/**
 * HotReload — re-registers routes and middleware when TS files change.
 *
 * The Hyper server (Rust) stays alive. Only the TypeScript handlers are swapped.
 * This gives sub-100ms reload times since no Rust recompilation is needed.
 *
 * @implements FR75, FR76
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface HotReloadOptions {
  /** Directories to watch for changes. */
  watchDirs: string[]
  /** File extensions to watch (default: ['.ts', '.js']). */
  extensions?: string[]
  /** Callback to execute on reload. */
  onReload: () => Promise<void> | void
  /** Debounce delay in ms (default: 50). */
  debounce?: number
  /** Logger (optional). */
  logger?: { info: (msg: string) => void }
}

/**
 * Watch TypeScript files and trigger handler re-registration on changes.
 * Returns a cleanup function to stop watching.
 */
export function startHotReload(options: HotReloadOptions): () => void {
  const extensions = options.extensions ?? ['.ts', '.js']
  const debounceMs = options.debounce ?? 50
  const logger = options.logger ?? { info: () => {} }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const watchers: fs.FSWatcher[] = []

  const handleChange = (filename: string | null) => {
    if (!filename || !extensions.some((ext) => filename.endsWith(ext))) return

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(async () => {
      const start = Date.now()
      try {
        await options.onReload()
        const duration = Date.now() - start
        logger.info(`Hot reload: ${duration}ms`)
      } catch (err) {
        logger.info(`Hot reload failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, debounceMs)
  }

  for (const dir of options.watchDirs) {
    const resolved = path.resolve(dir)
    if (!fs.existsSync(resolved)) continue

    try {
      const watcher = fs.watch(resolved, { recursive: true }, (_event, filename) => {
        handleChange(filename)
      })
      watchers.push(watcher)
    } catch {
      // fs.watch with recursive may not be supported on all platforms
    }
  }

  logger.info(`Hot reload watching: ${options.watchDirs.join(', ')}`)

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const w of watchers) w.close()
  }
}

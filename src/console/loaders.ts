/**
 * The two loaders Ace ships — `ListLoader` and `FsLoader`.
 *
 * A loader answers in two steps: the metadata of everything it offers, then the
 * class for one of them. The kernel reads the first at boot and the second only
 * when a command is asked for, so neither listing nor describing imports a
 * module nobody is going to run.
 */

import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { CommandLoader } from './Kernel.js'
import { serializeCommand } from './Kernel.js'
import { type CommandClass, isCommandClass, type SerializedCommand } from './types.js'

/**
 * Commands given as classes (Ace `ListLoader`).
 *
 * The form a package uses to ship its commands: they are already imported, so
 * there is nothing to defer.
 */
export class ListLoader implements CommandLoader {
  readonly #commands: readonly CommandClass[]

  constructor(commands: readonly CommandClass[]) {
    this.#commands = [...commands]
  }

  async getMetaData(): Promise<SerializedCommand[]> {
    return this.#commands.map(serializeCommand)
  }

  async getCommand(metadata: SerializedCommand): Promise<CommandClass | null> {
    return this.#commands.find((command) => command.commandName === metadata.commandName) ?? null
  }
}

/**
 * Commands found in a directory (Ace `FsLoader`).
 *
 * Reading the metadata imports each file — without a manifest there is no other
 * way to know what a file declares, and Ace's own `FsLoader` does the same. The
 * gain is elsewhere: `getCommand()` never imports anything twice.
 */
export class FsLoader implements CommandLoader {
  readonly #directory: URL
  readonly #filter: ((filePath: string) => boolean) | undefined
  readonly #commands = new Map<string, CommandClass>()
  readonly #paths = new Map<string, string>()
  #onSkipped: ((fileName: string) => void) | undefined

  /**
   * @param directory Where to look, as a path or a URL.
   * @param filter Files to keep. Everything is loaded when it is omitted.
   */
  constructor(directory: string | URL, filter?: (filePath: string) => boolean) {
    this.#directory = typeof directory === 'string' ? pathToFileURL(`${directory}/`) : directory
    this.#filter = filter
  }

  /**
   * Called for a file that exports no command.
   *
   * Reported rather than thrown: the directory is scanned by convention, so a
   * stray helper there must not make the whole CLI unusable.
   */
  onSkipped(handler: (fileName: string) => void): this {
    this.#onSkipped = handler
    return this
  }

  async getMetaData(): Promise<SerializedCommand[]> {
    let entries: Array<{ name: string; isDirectory(): boolean; parentPath?: string }>
    try {
      entries = await readdir(this.#directory, { withFileTypes: true, recursive: true })
    } catch {
      // No such directory — perfectly normal.
      return []
    }

    const files = entries
      .filter((entry) => !entry.isDirectory() && isCommandFile(entry.name))
      .map((entry) => new URL(entry.name, directoryUrl(entry.parentPath, this.#directory)))
      .filter((file) => this.#filter === undefined || this.#filter(file.pathname))
      .sort((a, b) => a.href.localeCompare(b.href))

    for (const file of files) {
      const command = commandOf(await this.import(file))
      if (command === undefined) {
        this.#onSkipped?.(file.pathname.split('/').pop() ?? file.pathname)
        continue
      }
      this.#commands.set(command.commandName, command)
      this.#paths.set(command.commandName, relativeTo(this.#directory, file))
    }

    return [...this.#commands.values()].map((command) => ({
      ...serializeCommand(command),
      filePath: this.#paths.get(command.commandName),
    }))
  }

  async getCommand(metadata: SerializedCommand): Promise<CommandClass | null> {
    return this.#commands.get(metadata.commandName) ?? null
  }

  /**
   * How a file is imported. Overridable because an application may compile its
   * own sources — Ream's Ignitor routes this through the app's importer.
   */
  protected import(file: URL): Promise<unknown> {
    return import(file.href)
  }
}

/** `./make/controller.ts` — how a manifest refers back to the file. */
function relativeTo(directory: URL, file: URL): string {
  return `./${file.href.slice(directory.href.length)}`
}

/** `.ts` / `.js` modules only, skipping declarations and `_private` helpers. */
function isCommandFile(name: string): boolean {
  if (name.startsWith('_') || name.endsWith('.d.ts')) return false
  return /\.(ts|js|mts|mjs)$/.test(name)
}

/**
 * `readdir(recursive)` reports nested entries via `parentPath`; older Node
 * builds omit it for top-level entries, where the base directory is correct.
 */
function directoryUrl(parentPath: string | undefined, fallback: URL): URL {
  if (parentPath === undefined) return fallback
  // `readdir` echoes the path it was given, which already ends with a slash
  // when it came from a URL. Adding a second one yields `…/commands//greet.ts`:
  // still importable, but wrong the moment the path is written to a manifest.
  const href = pathToFileURL(parentPath).href
  return new URL(href.endsWith('/') ? href : `${href}/`)
}

/** The command a module default-exports, or undefined when it exports none. */
function commandOf(mod: unknown): CommandClass | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined
  const value = Reflect.get(mod, 'default')
  return isCommandClass(value) ? value : undefined
}

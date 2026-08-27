/**
 * Recursive directory reads, as `fsReadAll` / `fsImportAll` in AdonisJS.
 *
 * What the framework itself uses to discover config files, preloads and
 * commands, and what an app reaches for to load a directory of modules.
 */

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ReadAllFilesOptions {
  /** Keep only files this returns true for. Defaults to `.js`/`.ts` modules. */
  filter?: (filePath: string, index: number) => boolean
  /** Sort the collected paths. Defaults to a stable alphabetical order. */
  sort?: (current: string, next: string) => number
  /** Ignore directories whose name this returns true for. */
  ignoreMissingRoot?: boolean
  /** Return absolute paths instead of paths relative to the root. */
  absolute?: boolean
  /** Also descend into subdirectories. Defaults to true. */
  recursive?: boolean
}

const DEFAULT_FILTER = (filePath: string): boolean =>
  /\.(js|ts|mjs|cjs|mts|cts)$/.test(filePath) && !/\.d\.ts$/.test(filePath)

/**
 * Every file under `location`, relative to it and alphabetically sorted.
 *
 * A missing root throws unless `ignoreMissingRoot` is set — an app that
 * declares no `config/` directory is legitimate, a typo in the path is not,
 * and only the caller can tell them apart.
 */
export async function fsReadAll(
  location: string | URL,
  options: ReadAllFilesOptions = {},
): Promise<string[]> {
  const root = location instanceof URL ? location.pathname : location
  const filter = options.filter ?? DEFAULT_FILTER
  const recursive = options.recursive ?? true

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true, recursive })
  } catch (error) {
    if (options.ignoreMissingRoot && isMissing(error)) return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    // `parentPath` is where recursive readdir puts the containing directory.
    const absolute = join(entry.parentPath ?? root, entry.name)
    const value = options.absolute ? absolute : relative(root, absolute).split(sep).join('/')
    files.push(value)
  }

  const kept = files.filter((file, index) => filter(file, index))
  return options.sort ? kept.sort(options.sort) : kept.sort()
}

export interface ImportAllFilesOptions extends ReadAllFilesOptions {
  /** Turn a file path into the key it lands under. Defaults to the path minus its extension. */
  transformKeys?: (key: string) => string
}

/**
 * Import every file under `location`, keyed by its path minus the extension.
 *
 * A module with a default export contributes that export; one without
 * contributes its named exports as a plain object — the same rule the config
 * loader follows, and for the same reason.
 */
export async function fsImportAll(
  location: string | URL,
  options: ImportAllFilesOptions = {},
): Promise<Record<string, unknown>> {
  const root = location instanceof URL ? location.pathname : location
  const files = await fsReadAll(root, options)
  const collected: Record<string, unknown> = {}

  for (const file of files) {
    const key = (options.transformKeys ?? stripExtension)(file)
    const module: Record<string, unknown> = await import(pathToFileURL(join(root, file)).href)
    collected[key] = 'default' in module ? module.default : { ...module }
  }
  return collected
}

function stripExtension(file: string): string {
  return file.replace(/\.(js|ts|mjs|cjs|mts|cts)$/, '')
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

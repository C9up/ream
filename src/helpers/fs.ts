/**
 * Recursive directory reads, as `fsReadAll` / `fsImportAll` in AdonisJS.
 *
 * What the framework itself uses to discover config files, preloads and
 * commands, and what an app reaches for to load a directory of modules.
 */

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** How `fsReadAll` spells each path it returns. */
export type ReadAllPathType = 'relative' | 'unixRelative' | 'absolute' | 'unixAbsolute' | 'url'

export interface ReadAllFilesOptions {
  /** Return `[]` instead of throwing when the root directory does not exist. */
  ignoreMissingRoot?: boolean
  /** Keep only files this returns true for. Receives each path as `pathType` spells it. */
  filter?: (filePath: string, index: number) => boolean
  /** Sort the collected paths. Defaults to a natural sort (`2.js` before `10.js`). */
  sort?: (current: string, next: string) => number
  /** How each path is spelled. Defaults to `relative` (to the root, OS separators). */
  pathType?: ReadAllPathType
  /**
   * Also descend into subdirectories. Defaults to true. A ream addition: the
   * AdonisJS helper always recurses.
   */
  recursive?: boolean
}

let collator: Intl.Collator | undefined

/** The default order: numeric-aware, case-insensitive (`@poppinss/utils` naturalSort). */
function naturalSort(current: string, next: string): number {
  collator ??= new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
  return collator.compare(current, next)
}

/**
 * Every file under `location`, relative to it and naturally sorted.
 *
 * Dot-files and anything under a dot-directory are left out: an editor's
 * `.#app.ts` lock copy, a `.backup.ts` or a `.cache/` directory is never part
 * of the set (and `fsImportAll` would otherwise execute it).
 *
 * A missing root throws unless `ignoreMissingRoot` is set — an app that
 * declares no `config/` directory is legitimate, a typo in the path is not,
 * and only the caller can tell them apart.
 */
export async function fsReadAll(
  location: string | URL,
  options: ReadAllFilesOptions = {},
): Promise<string[]> {
  // `fileURLToPath`, never `.pathname`: the pathname is percent-encoded
  // (`my%20app`) and, on Windows, `/C:/…` — a directory that does not exist.
  const root = typeof location === 'string' ? location : fileURLToPath(location)
  const pathType = options.pathType ?? 'relative'
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
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    // `parentPath` is where recursive readdir puts the containing directory.
    const parent = entry.parentPath ?? root
    const directory = relative(root, parent)
    if (directory !== '' && directory.split(sep).some((segment) => segment.startsWith('.')))
      continue
    files.push(formatPath(root, parent, entry.name, pathType))
  }

  const kept = options.filter ? files.filter(options.filter) : files
  return kept.sort(options.sort ?? naturalSort)
}

function formatPath(root: string, parent: string, name: string, pathType: ReadAllPathType): string {
  switch (pathType) {
    case 'relative':
      return join(relative(root, parent), name)
    case 'unixRelative':
      return toUnixSlash(join(relative(root, parent), name))
    case 'absolute':
      return join(parent, name)
    case 'unixAbsolute':
      return toUnixSlash(join(parent, name))
    case 'url':
      return pathToFileURL(join(parent, name)).href
  }
}

function toUnixSlash(path: string): string {
  return path.split(sep).join('/')
}

export interface ImportAllFilesOptions extends Omit<ReadAllFilesOptions, 'pathType'> {
  /**
   * Turn a file's key segments (its path minus the extension, split on the
   * separator: `database/pg.ts` → `['database', 'pg']`) into the segments it
   * lands under.
   */
  transformKeys?: (keys: string[]) => string[]
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.json', '.cjs', '.mjs', '.ts', '.mts', '.cts'])

/**
 * The default `fsImportAll` filter (`@poppinss/utils` isScriptFile): script
 * modules and JSON, never a declaration file. `.mts`/`.cts` are accepted too,
 * since the loaders ream runs under import them like `.ts`.
 */
function isScriptFile(filePath: string): boolean {
  if (/\.d\.[mc]?ts$/.test(filePath)) return false
  return SCRIPT_EXTENSIONS.has(extname(filePath))
}

/**
 * Import every file under `location` into one object nested by path segment:
 * `config/database/pg.ts` lands at `collection.database.pg`.
 *
 * A module with a default export contributes that export; one without
 * contributes its named exports as a plain object — the same rule the config
 * loader follows, and for the same reason. `.json` files are imported with the
 * JSON import attribute.
 */
export async function fsImportAll(
  location: string | URL,
  options: ImportAllFilesOptions = {},
): Promise<Record<string, unknown>> {
  const root = typeof location === 'string' ? location : fileURLToPath(location)
  const files = await fsReadAll(root, { filter: isScriptFile, ...options, pathType: 'url' })
  const collected: Record<string, unknown> = {}

  await Promise.all(
    files.map(async (fileURL) => {
      const filePath = fileURLToPath(fileURL)
      const extension = extname(filePath)
      const relativePath = relative(root, filePath)
      const segments = relativePath.slice(0, relativePath.length - extension.length).split(sep)
      const module: Record<string, unknown> =
        extension === '.json'
          ? await import(fileURL, { with: { type: 'json' } })
          : await import(fileURL)
      const value = module.default ? module.default : { ...module }
      setNested(
        collected,
        options.transformKeys ? options.transformKeys(segments) : segments,
        value,
      )
    }),
  )
  return collected
}

/** Segments that would walk onto a prototype instead of an own key. */
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Assign `value` at `segments`, creating plain objects on the way. A segment
 * list naming a prototype is refused, as lodash `set` does.
 */
function setNested(target: Record<string, unknown>, segments: string[], value: unknown): void {
  if (segments.some((segment) => RESERVED_SEGMENTS.has(segment))) return
  const last = segments[segments.length - 1]
  if (last === undefined) return
  let current = target
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (isRecord(next)) {
      current = next
    } else {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
    }
  }
  current[last] = value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

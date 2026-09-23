/**
 * Finding a stub, rendering it, and knowing where it goes.
 *
 * A stub is addressed the way `codemods.makeUsingStub` addresses one — a
 * package's `stubsRoot` plus a path inside it, `make/controller.stub` — so a
 * generator and a package's `configure()` hook read the same file through the
 * same rule. The application's own copy under `stubs/` wins over the shipped
 * one, which is what `ream eject` is for.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { render, type StubState } from '../../stubs/template.js'

/** Where an application keeps its own copies — Adonis' `stubs/` root. */
export const PUBLISHED_ROOT = 'stubs'

/** The stubs this package ships. */
export const REAM_STUBS_ROOT = path.join(import.meta.dirname, '..', '..', '..', 'stubs')

export interface RenderedStub {
  /** Relative to the project root, as the stub's front matter declares it. */
  path: string
  contents: string
  /** Did the application's own copy win? */
  published: boolean
}

/**
 * A stub path that could escape its root never reaches the filesystem.
 *
 * `eject` takes one from the command line, so this is the boundary: no
 * absolute path, no `..`, and a `.stub` file at the end of it.
 */
export function isSafeStubPath(stubPath: string): boolean {
  if (stubPath === '' || stubPath.length > 256) return false
  if (path.isAbsolute(stubPath)) return false
  const segments = stubPath.split(/[/\\]/)
  if (segments.includes('..') || segments.includes('')) return false
  return segments.every((segment) => /^[\w.-]+$/.test(segment))
}

/** Where the application's copy of `stubPath` would live. */
export function publishedPath(stubPath: string, cwd: string): string | undefined {
  if (!isSafeStubPath(stubPath)) return undefined
  return path.join(cwd, PUBLISHED_ROOT, stubPath)
}

/** Read `stubPath` — the application's copy when there is one. */
export function readStub(
  stubsRoot: string,
  stubPath: string,
  cwd: string,
): { source: string; published: boolean } {
  const published = publishedPath(stubPath, cwd)
  if (published !== undefined && fs.existsSync(published)) {
    return { source: fs.readFileSync(published, 'utf8'), published: true }
  }
  if (!isSafeStubPath(stubPath)) {
    throw new Error(`[make] unusable stub path: ${stubPath}`)
  }
  const shipped = path.join(stubsRoot, stubPath)
  if (!fs.existsSync(shipped)) {
    throw new Error(`[make] no stub at "${stubPath}" (looked in ${stubsRoot})`)
  }
  return { source: fs.readFileSync(shipped, 'utf8'), published: false }
}

/** Split `---\nto: …\n---\n<body>`; the front matter names the destination. */
export function splitFrontMatter(template: string): { to?: string; body: string } {
  const trimmed = template.replace(/^[﻿\r\n]+/, '')
  if (!trimmed.startsWith('---')) return { body: template }
  const after = trimmed.slice(3).replace(/^\r?\n/, '')
  const end = after.indexOf('\n---')
  if (end === -1) {
    throw new Error('[make] a stub opened its front matter with `---` and never closed it')
  }
  const block = after.slice(0, end)
  const body = after.slice(end + 4).replace(/^\r?\n/, '')
  let to: string | undefined
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at === -1) throw new Error(`[make] unreadable stub front-matter line: \`${line}\``)
    if (line.slice(0, at).trim() === 'to') to = line.slice(at + 1).trim()
  }
  return to === undefined ? { body } : { to, body }
}

/**
 * The destination a stub declares, checked.
 *
 * Absolute paths and `..` are refused rather than normalised: a published stub
 * is a file in the project, and a generator is not a way to write outside it.
 */
function assertInsideProject(destination: string): void {
  if (destination === '') throw new Error('[make] the stub declares an empty destination')
  if (path.isAbsolute(destination)) {
    throw new Error(`[make] a stub may not write to an absolute path: ${destination}`)
  }
  if (destination.split(/[/\\]/).includes('..')) {
    throw new Error(`[make] a stub may not write outside the project: ${destination}`)
  }
}

export function renderStub(
  stubsRoot: string,
  stubPath: string,
  state: StubState,
  cwd: string,
  fallbackPath?: string,
): RenderedStub {
  const { source, published } = readStub(stubsRoot, stubPath, cwd)
  const { to, body } = splitFrontMatter(source)
  const destination = to === undefined ? fallbackPath : render(to, state)
  if (destination === undefined) {
    throw new Error(
      `[make] the stub at "${stubPath}" declares no destination — add a \`to:\` front-matter line.`,
    )
  }
  assertInsideProject(destination)
  return { path: destination, contents: render(body, state), published }
}

/** `make/controller.stub` — the stub a generator of that kind reads. */
export function stubPathFor(kind: string): string {
  return `make/${kind}.stub`
}

/** Render one of this package's own generator stubs. */
export function renderStubFor(kind: string, state: StubState, cwd: string): RenderedStub {
  return renderStub(REAM_STUBS_ROOT, stubPathFor(kind), state, cwd)
}

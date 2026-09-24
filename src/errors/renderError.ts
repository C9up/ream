/**
 * An error, rendered for someone reading a terminal.
 *
 * Upstream hands this to youch. Written here instead, for the reason lumen was
 * written rather than a colour package taken: a dependency is code we do not
 * control, shipped into every application that installs the framework.
 *
 * The expensive part of doing this properly is usually reading source maps to
 * get from a transpiled frame back to the line someone wrote. It is not needed
 * here: `ream dev` runs TypeScript through swc-node, which already reports
 * `app/controllers/users_controller.ts:24:11` — measured, not assumed. A build
 * that does not, or a frame whose file cannot be read, falls back to the plain
 * stack rather than showing nothing.
 *
 * NOTHING here may throw. This is what runs when something has already gone
 * wrong, and an error thrown while rendering an error replaces the one you
 * needed to see.
 */

import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ansiColors, silentColors, supportsColor } from '@c9up/lumen'

/** One line of a stack, taken apart. */
export interface StackFrame {
  /** The function, when the runtime named one. */
  callee?: string
  file: string
  line: number
  column: number
  /** Where it comes from, which is what decides how much of it is shown. */
  origin: 'application' | 'dependency' | 'runtime'
}

export interface RenderOptions {
  /** Paths are printed relative to this. Defaults to the working directory. */
  cwd?: string
  /** Lines of source shown around the failing one. */
  context?: number
  /** Force colour on or off. Defaults to what the stream takes. */
  colors?: boolean
}

const AT_WITH_CALLEE = /^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/
const AT_BARE = /^\s*at\s+(.+):(\d+):(\d+)$/

/**
 * Take a stack apart.
 *
 * A line that matches neither shape is dropped rather than guessed at: a
 * malformed frame in the middle of a trace is worse than a shorter trace.
 */
export function parseStack(stack: string | undefined, cwd: string): StackFrame[] {
  if (stack === undefined) return []
  const frames: StackFrame[] = []

  for (const raw of stack.split('\n').slice(1)) {
    const withCallee = AT_WITH_CALLEE.exec(raw)
    const bare = withCallee === null ? AT_BARE.exec(raw) : null
    const parts = withCallee ?? bare
    if (parts === null) continue

    const callee = withCallee === null ? undefined : parts[1]
    const location = withCallee === null ? parts[1] : parts[2]
    const line = Number(withCallee === null ? parts[2] : parts[3])
    const column = Number(withCallee === null ? parts[3] : parts[4])
    if (location === undefined || !Number.isInteger(line)) continue

    const file = toPath(location)
    frames.push({
      ...(callee === undefined ? {} : { callee }),
      file,
      line,
      column: Number.isInteger(column) ? column : 0,
      origin: originOf(file, cwd),
    })
  }
  return frames
}

/** The whole thing: message, the failing line in context, the trace, the cause. */
export function renderError(error: unknown, options: RenderOptions = {}): string {
  try {
    return render(error, options, new Set())
  } catch {
    // The renderer failed on the error it was asked to show. Whatever it was
    // is still more useful than a second failure.
    return String(error instanceof Error ? (error.stack ?? error.message) : error)
  }
}

function render(error: unknown, options: RenderOptions, seen: Set<unknown>): string {
  const colors = options.colors === undefined ? forStream() : palette(options.colors)
  const cwd = options.cwd ?? process.cwd()

  if (!(error instanceof Error)) {
    return `\n  ${colors.red('Error')}  ${String(error)}\n`
  }
  // A cause that points back at something already rendered would recurse
  // forever; errors do get wired in circles.
  if (seen.has(error)) return ''
  seen.add(error)

  const out: string[] = ['']
  const name = error.name === '' ? 'Error' : error.name
  out.push(`  ${colors.bgRed(colors.white(` ${name} `))} ${colors.red(error.message)}`)

  const frames = parseStack(error.stack, cwd)
  const first = frames.find((frame) => frame.origin === 'application') ?? frames[0]

  if (first !== undefined) {
    const excerpt = sourceExcerpt(first, options.context ?? 3, colors)
    if (excerpt.length > 0) {
      out.push('')
      out.push(`  ${colors.dim(`${relativeTo(first.file, cwd)}:${first.line}:${first.column}`)}`)
      out.push('')
      out.push(...excerpt)
    }
  }

  const trace = frames.filter((frame) => frame.origin !== 'runtime')
  if (trace.length > 0) {
    out.push('')
    for (const frame of trace.slice(0, 12)) {
      const where = `${relativeTo(frame.file, cwd)}:${frame.line}`
      const callee = frame.callee === undefined ? '' : `${frame.callee} `
      const line = `    at ${callee}${where}`
      // A frame from a dependency is dimmed rather than dropped: it is where
      // the failure passed through, and hiding it makes a trace lie.
      out.push(frame.origin === 'application' ? line : colors.dim(line))
    }
  }

  const cause = 'cause' in error ? error.cause : undefined
  if (cause !== undefined && cause !== null) {
    const rendered = render(cause, options, seen)
    if (rendered !== '') {
      out.push('')
      out.push(`  ${colors.dim('caused by')}`)
      out.push(rendered)
    }
  }

  out.push('')
  return out.join('\n')
}

/**
 * The failing line, with the ones around it.
 *
 * Empty when the file cannot be read — a frame inside a bundle, a file deleted
 * since the process started, a permission. The trace still prints.
 */
function sourceExcerpt(
  frame: StackFrame,
  context: number,
  colors: ReturnType<typeof ansiColors>,
): string[] {
  let source: string
  try {
    source = readFileSync(frame.file, 'utf8')
  } catch {
    return []
  }

  const lines = source.split('\n')
  const start = Math.max(1, frame.line - context)
  const end = Math.min(lines.length, frame.line + context)
  const gutter = String(end).length

  const out: string[] = []
  for (let number = start; number <= end; number++) {
    const text = lines[number - 1] ?? ''
    const label = String(number).padStart(gutter, ' ')
    if (number === frame.line) {
      out.push(`  ${colors.red('❯')} ${colors.red(label)} │ ${text}`)
      if (frame.column > 0) {
        // The caret under the column the runtime reported. Tabs are copied
        // across so the caret lands under the character, not beside it.
        const prefix = text.slice(0, frame.column - 1).replace(/[^\t]/g, ' ')
        out.push(`    ${' '.repeat(gutter)} │ ${prefix}${colors.red('^')}`)
      }
    } else {
      out.push(`    ${colors.dim(label)} ${colors.dim('│')} ${colors.dim(text)}`)
    }
  }
  return out
}

/** `file:///a/b.ts` and `/a/b.ts` both name the same file. */
function toPath(location: string): string {
  if (!location.startsWith('file:')) return location
  try {
    return fileURLToPath(location)
  } catch {
    return location
  }
}

function originOf(file: string, cwd: string): StackFrame['origin'] {
  if (file.startsWith('node:') || !file.includes(sep)) return 'runtime'
  if (file.includes(`${sep}node_modules${sep}`)) return 'dependency'
  return file.startsWith(cwd) ? 'application' : 'dependency'
}

/**
 * The shortest path that still says where a frame is.
 *
 * A dependency frame is cut back to what comes after the last
 * `node_modules/`, because the part before it is a store layout nobody reads:
 * `@vitest/runner/dist/chunk-artifact.js`, not
 * `…/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/…`.
 */
function relativeTo(file: string, cwd: string): string {
  if (file.startsWith('node:')) return file
  const marker = `${sep}node_modules${sep}`
  const last = file.lastIndexOf(marker)
  if (last !== -1) return file.slice(last + marker.length)
  const path = relative(cwd, file)
  return path === '' || path.startsWith('..') ? file : path
}

function forStream(): ReturnType<typeof ansiColors> {
  return supportsColor(process.stderr) ? ansiColors() : silentColors()
}

function palette(on: boolean): ReturnType<typeof ansiColors> {
  return on ? ansiColors() : silentColors()
}

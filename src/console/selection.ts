/**
 * Picking from a list with the arrow keys.
 *
 * Upstream's prompts are enquirer, so its selection prompts navigate: up and
 * down move a pointer, space ticks a box, enter answers. Typing a number
 * instead — which is what this package did — is the same prompt only in the
 * sense that it eventually returns a value.
 *
 * Written here rather than taken from a package, for the reason lumen was
 * written rather than `@poppinss/cliui` taken: a dev-time dependency is a
 * dependency every application installs. What a selection prompt needs is
 * bounded — raw mode, five keys, and redrawing in place — and it is all below.
 *
 * Only ever entered on a TTY. A prompt with nothing to read from is refused
 * before this by the caller, which is what makes the loop here able to assume
 * a terminal.
 */

import { stdin, stdout } from 'node:process'
import { clearLine, cursorTo, moveCursor } from 'node:readline'
import { ReamError } from '../errors/ReamError.js'
import { colourise } from './ui.js'

/** One line of the list, as the renderer needs it. */
export interface SelectionItem {
  label: string
  hint?: string
}

export interface SelectionOptions {
  /** Printed above the list. */
  title: string
  items: readonly SelectionItem[]
  /** Tick boxes and let several be picked. */
  many?: boolean
  /** Where the pointer starts, and what is ticked to begin with. */
  selected?: readonly number[]
  /** Type to narrow the list — the autocomplete case. */
  filter?: boolean
  /** How many lines of the list to show at once. */
  limit?: number
  /** Where the keys come from. Defaults to this process's stdin. */
  input?: NodeJS.ReadStream
  /** Where the list is drawn. Defaults to this process's stdout. */
  output?: NodeJS.WriteStream
}

/** What the user did. Cancelling is not an empty answer, it is no answer. */
export type SelectionResult = { kind: 'picked'; indexes: number[] } | { kind: 'cancelled' }

const ARROW_UP = '\u001B[A'
const ARROW_DOWN = '\u001B[B'
const ARROW_LEFT = '\u001B[D'
const ARROW_RIGHT = '\u001B[C'
const ENTER = ['\r', '\n']
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const ESCAPE = '\u001B'
const BACKSPACE = ['\u0008', '\u007F']

/**
 * Run the list until the user answers.
 *
 * Resolves with the chosen indexes, in the order they were ticked for a
 * multiple — the order the user built them in is the order they expect back.
 */
export function runSelection(options: SelectionOptions): Promise<SelectionResult> {
  if (options.items.length === 0) {
    return Promise.reject(
      new ReamError('E_CONSOLE_EMPTY_CHOICES', `"${options.title}" was asked with no options.`),
    )
  }

  const input = options.input ?? stdin
  const output = options.output ?? stdout

  const state = {
    // The pointer starts on the default rather than at the top: for a single
    // choice that IS the default, since enter takes whatever it is on.
    cursor: Math.max(0, options.selected?.[0] ?? 0),
    ticked: new Set<number>(options.selected ?? []),
    query: '',
    /** Lines drawn last time, so the next draw can wipe exactly those. */
    drawn: 0,
  }
  const limit = Math.max(1, options.limit ?? 10)

  const visible = (): number[] => {
    if (options.filter !== true || state.query === '') return options.items.map((_, i) => i)
    const needle = state.query.toLowerCase()
    return options.items
      .map((_, index) => index)
      .filter((index) => (options.items[index]?.label ?? '').toLowerCase().includes(needle))
  }

  return new Promise<SelectionResult>((resolve, reject) => {
    const finish = (result: SelectionResult): void => {
      erase(output, state.drawn)
      teardown()
      resolve(result)
    }

    const onData = (chunk: Buffer | string): void => {
      const key = chunk.toString()
      const shown = visible()

      if (key === CTRL_C || key === CTRL_D || key === ESCAPE) {
        finish({ kind: 'cancelled' })
        return
      }

      if (ENTER.includes(key)) {
        if (options.many === true) {
          finish({ kind: 'picked', indexes: [...state.ticked] })
          return
        }
        const index = shown[state.cursor]
        // Enter on a filter that matches nothing answers nothing: there is no
        // line under the pointer to take.
        if (index === undefined) return
        finish({ kind: 'picked', indexes: [index] })
        return
      }

      if (key === ARROW_UP) {
        state.cursor = state.cursor === 0 ? shown.length - 1 : state.cursor - 1
      } else if (key === ARROW_DOWN) {
        state.cursor = state.cursor === shown.length - 1 ? 0 : state.cursor + 1
      } else if (options.many === true && key === ' ') {
        const index = shown[state.cursor]
        if (index !== undefined) {
          if (state.ticked.has(index)) state.ticked.delete(index)
          else state.ticked.add(index)
        }
      } else if (options.many === true && (key === ARROW_LEFT || key === ARROW_RIGHT)) {
        // Upstream's multiple ticks and unticks with left and right too.
        const index = shown[state.cursor]
        if (index !== undefined) {
          if (key === ARROW_RIGHT) state.ticked.add(index)
          else state.ticked.delete(index)
        }
      } else if (options.filter === true && BACKSPACE.includes(key)) {
        state.query = state.query.slice(0, -1)
        state.cursor = 0
      } else if (options.filter === true && isTypable(key)) {
        state.query += key
        state.cursor = 0
      } else {
        // A key nothing is bound to must not redraw: a mouse event arrives as
        // a burst of escape sequences, and redrawing on each one flickers.
        return
      }

      draw()
    }

    const draw = (): void => {
      erase(output, state.drawn)
      const shown = visible()
      if (state.cursor >= shown.length) state.cursor = Math.max(0, shown.length - 1)

      const lines: string[] = [heading(options, state.query)]
      const window = windowOf(shown.length, state.cursor, limit)
      for (let row = window.start; row < window.end; row++) {
        const index = shown[row]
        if (index === undefined) continue
        const item = options.items[index]
        if (item === undefined) continue
        lines.push(
          renderItem(item, row === state.cursor, options.many === true, state.ticked.has(index)),
        )
      }
      if (shown.length === 0) lines.push(colourise('  no match', 'dim'))
      if (shown.length > window.end - window.start) {
        lines.push(colourise(`  … ${shown.length - (window.end - window.start)} more`, 'dim'))
      }

      for (const line of lines) output.write(`${line}\n`)
      state.drawn = lines.length
    }

    const teardown = (): void => {
      input.removeListener('data', onData)
      if (input.isTTY) input.setRawMode(false)
      input.pause()
    }

    try {
      if (!input.isTTY) {
        throw new ReamError(
          'E_CONSOLE_NOT_INTERACTIVE',
          `Cannot prompt for "${options.title}" — stdin is not interactive.`,
          { hint: 'Pass the value as a flag, or script the answer with prompt.trap(name).' },
        )
      }
      input.setRawMode(true)
      input.resume()
      input.on('data', onData)
      draw()
    } catch (error) {
      teardown()
      reject(error)
    }
  })
}

/** The title line, with what has been typed so far when there is a filter. */
function heading(options: SelectionOptions, query: string): string {
  const help =
    options.many === true
      ? colourise(' (space to pick, enter to confirm)', 'dim')
      : colourise(' (use arrow keys)', 'dim')
  const typed = options.filter === true && query !== '' ? ` ${colourise(query, 'cyan')}` : ''
  return `${colourise('?', 'green')} ${options.title}${typed}${help}`
}

/**
 * One line of the list.
 *
 * A pointer says where you are; a box, only on a multiple, says what is
 * taken. Without the box a multiple has no way to show four ticks at once,
 * which is the whole of what it is for.
 */
function renderItem(
  item: SelectionItem,
  underCursor: boolean,
  many: boolean,
  ticked: boolean,
): string {
  const pointer = underCursor ? colourise('❯', 'cyan') : ' '
  const box = many ? `${ticked ? colourise('◉', 'cyan') : '◯'} ` : ''
  const label = underCursor ? colourise(item.label, 'cyan') : item.label
  const hint = item.hint === undefined ? '' : colourise(` — ${item.hint}`, 'dim')
  return `${pointer} ${box}${label}${hint}`
}

/**
 * Which slice of a long list to show.
 *
 * Kept around the cursor rather than paged: a pointer that walks off the
 * bottom and reappears at the top of a new page loses the reader.
 */
function windowOf(total: number, cursor: number, limit: number): { start: number; end: number } {
  if (total <= limit) return { start: 0, end: total }
  const half = Math.floor(limit / 2)
  const start = Math.min(Math.max(0, cursor - half), total - limit)
  return { start, end: start + limit }
}

/** Wipe the lines drawn last time, so the next draw replaces them. */
function erase(output: NodeJS.WriteStream, lines: number): void {
  if (lines === 0) return
  for (let row = 0; row < lines; row++) {
    moveCursor(output, 0, -1)
    cursorTo(output, 0)
    clearLine(output, 0)
  }
}

/**
 * Printable text, and not an escape sequence.
 *
 * A chunk, not a character: typing quickly — or pasting — delivers several at
 * once, and a filter that took only single-character chunks silently dropped
 * everything typed faster than the event loop.
 */
function isTypable(chunk: string): boolean {
  if (chunk.length === 0) return false
  for (const character of chunk) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

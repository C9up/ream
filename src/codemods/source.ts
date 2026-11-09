/**
 * Just enough of a TypeScript scanner for the configure codemods: find a
 * call or an object/array literal in CODE (never inside a string, a template
 * or a comment), split a literal into its top-level entries, and append to
 * one. Upstream does this with a full AST; ream ships no compiler, and the
 * files these codemods edit (`start/env.ts`, `reamrc.ts`) are object and
 * array literals.
 *
 * Not handled: regular-expression literals (a quote inside one reads as the
 * start of a string). Neither file has a reason to contain one.
 */

const CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char)
}

/**
 * The index just past the string, template or comment starting at `i`, or
 * `i` itself when none starts there. An unterminated one runs to the end.
 */
function skipNonCode(src: string, i: number): number {
  const char = src[i]
  const next = src[i + 1]
  if (char === '/' && next === '/') {
    const end = src.indexOf('\n', i)
    return end === -1 ? src.length : end
  }
  if (char === '/' && next === '*') {
    const end = src.indexOf('*/', i + 2)
    return end === -1 ? src.length : end + 2
  }
  if (char === "'" || char === '"') {
    let j = i + 1
    while (j < src.length && src[j] !== char && src[j] !== '\n') {
      j += src[j] === '\\' ? 2 : 1
    }
    return j + 1
  }
  if (char === '`') {
    let j = i + 1
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') {
        j += 2
      } else if (src[j] === '$' && src[j + 1] === '{') {
        const close = matchClose(src, j + 1)
        j = close === -1 ? src.length : close + 1
      } else {
        j += 1
      }
    }
    return j + 1
  }
  return i
}

/** Whether the string, template or block comment starting at `i` is closed. */
function isTerminated(src: string, i: number): boolean {
  const char = src[i]
  if (char === '/') return src.indexOf('*/', i + 2) !== -1
  const end = skipNonCode(src, i)
  return end <= src.length && end - 1 > i && src[end - 1] === char
}

/** Index of the bracket closing the one at `open`, or -1. */
export function matchClose(src: string, open: number): number {
  const first = CLOSERS[src[open] ?? '']
  if (first === undefined) return -1
  const stack = [first]
  let i = open + 1
  while (i < src.length) {
    const skipped = skipNonCode(src, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    const char = src[i] ?? ''
    const closer = CLOSERS[char]
    if (closer !== undefined) {
      stack.push(closer)
    } else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return i
    } else if (char === '}' || char === ']' || char === ')') {
      return -1
    }
    i += 1
  }
  return -1
}

/** First code character at or after `i` (before `end`), skipping whitespace and comments. */
function firstCode(src: string, i: number, end: number): number {
  let j = i
  while (j < end) {
    const char = src[j] ?? ''
    if (/\s/.test(char)) {
      j += 1
      continue
    }
    if (char === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) {
      j = skipNonCode(src, j)
      continue
    }
    return j
  }
  return end
}

/** One top-level entry of a literal: the text between two commas. */
export interface Segment {
  start: number
  end: number
  /** First code character, or `end` when the entry is only trivia. */
  codeStart: number
  /** Just past the last code character (comments and whitespace excluded). */
  codeEnd: number
}

/** Split `src[start, end)` on its top-level commas. */
export function segments(src: string, start: number, end: number): Segment[] {
  const out: Segment[] = []
  let segmentStart = start
  let codeEnd = start
  let depth = 0
  let i = start
  const close = (at: number) => {
    const codeStart = firstCode(src, segmentStart, at)
    out.push({ start: segmentStart, end: at, codeStart, codeEnd: Math.max(codeEnd, codeStart) })
  }
  while (i < end) {
    const char = src[i] ?? ''
    if (char === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipNonCode(src, i)
      continue
    }
    const skipped = skipNonCode(src, i)
    if (skipped !== i) {
      i = skipped
      codeEnd = i
      continue
    }
    if (char === ',' && depth === 0) {
      close(i)
      segmentStart = i + 1
      codeEnd = i + 1
      i += 1
      continue
    }
    if (CLOSERS[char] !== undefined) depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    if (!/\s/.test(char)) codeEnd = i + 1
    i += 1
  }
  close(end)
  return out
}

/**
 * Whether `code` is one complete expression that cannot reach outside the
 * slot it is written into: brackets balanced and never closing past where
 * they opened, strings and comments terminated, no top-level comma.
 */
export function isSingleExpression(code: string): boolean {
  if (code.trim() === '') return false
  let depth = 0
  let i = 0
  while (i < code.length) {
    const skipped = skipNonCode(code, i)
    if (skipped !== i) {
      // A line comment would swallow the comma written after the value.
      const lineComment = code[i] === '/' && code[i + 1] === '/'
      if (lineComment || !isTerminated(code, i)) return false
      i = skipped
      continue
    }
    const char = code[i] ?? ''
    if (CLOSERS[char] !== undefined) depth += 1
    else if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth < 0) return false
    } else if (char === ',' && depth === 0) return false
    i += 1
  }
  return depth === 0
}

/**
 * Index of the `(` of the first call to `callee` in code, or -1. A mention
 * inside a string or a comment, or as the tail of a longer name
 * (`MyEnv.create`), does not count.
 */
export function findCall(src: string, callee: string): number {
  let i = 0
  while (i < src.length) {
    const skipped = skipNonCode(src, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    const before = src[i - 1]
    if (src.startsWith(callee, i) && !isIdentifierChar(before) && before !== '.') {
      const paren = firstCode(src, i + callee.length, src.length)
      if (src[paren] === '(') return paren
    }
    i += 1
  }
  return -1
}

/** Index of the `{` after the first `export default` in code, or -1. */
export function findExportDefaultObject(src: string): number {
  let i = 0
  while (i < src.length) {
    const skipped = skipNonCode(src, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    if (src.startsWith('export', i) && !isIdentifierChar(src[i - 1])) {
      const word = firstCode(src, i + 'export'.length, src.length)
      if (src.startsWith('default', word) && !isIdentifierChar(src[word + 'default'.length])) {
        const brace = firstCode(src, word + 'default'.length, src.length)
        return src[brace] === '{' ? brace : -1
      }
    }
    i += 1
  }
  return -1
}

/** A `key: value` entry of an object literal. */
export interface Property {
  key: string
  valueStart: number
  valueEnd: number
}

/** The `key: value` entries of the object literal opening at `open`. */
export function properties(src: string, open: number, close: number): Property[] {
  const out: Property[] = []
  for (const segment of segments(src, open + 1, close)) {
    if (segment.codeStart >= segment.end) continue
    const text = src.slice(segment.codeStart, segment.end)
    const match = /^(?:([A-Za-z_$][\w$]*)|'([^'\\\n]*)'|"([^"\\\n]*)")\s*:/.exec(text)
    if (match === null) continue
    const key = match[1] ?? match[2] ?? match[3] ?? ''
    const valueStart = firstCode(src, segment.codeStart + match[0].length, segment.end)
    out.push({ key, valueStart, valueEnd: segment.codeEnd })
  }
  return out
}

/** Leading whitespace of the line holding `index`. */
function lineIndent(src: string, index: number): string {
  const lineStart = src.lastIndexOf('\n', index - 1) + 1
  return /^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? ''
}

/**
 * Append entries to the literal `src[open..close]` and return the new text.
 *
 * `build` receives the indentation of the existing entries (or one level
 * deeper than the closing bracket when there are none) and returns the lines
 * to add, each already ending with its comma. `blankLine` separates the new
 * entries from existing ones. A missing comma after the last existing entry
 * is added.
 */
export function appendToLiteral(
  src: string,
  open: number,
  close: number,
  eol: string,
  build: (indent: string) => string[],
  blankLine = false,
): string {
  const all = segments(src, open + 1, close)
  const entries = all.filter((s) => s.codeStart < s.end)
  const first = entries[0]
  const closeIndent = lineIndent(src, close)
  const firstOnOwnLine =
    first !== undefined &&
    /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', first.codeStart - 1) + 1, first.codeStart))
  const indent =
    first !== undefined && firstOnOwnLine ? lineIndent(src, first.codeStart) : `${closeIndent}  `
  const lines = build(indent)
  const separator = blankLine && entries.length > 0 ? eol : ''

  const closeLineStart = src.lastIndexOf('\n', close - 1) + 1
  const closeOnOwnLine = /^[ \t]*$/.test(src.slice(closeLineStart, close))
  let out = closeOnOwnLine
    ? `${src.slice(0, closeLineStart)}${separator}${lines.join(eol)}${eol}${src.slice(closeLineStart)}`
    : `${src.slice(0, close)}${eol}${separator}${lines.join(eol)}${eol}${closeIndent}${src.slice(close)}`

  // The comma goes in last, as it sits before every insertion point above.
  // No comma after the last entry when it is also the last segment.
  const last = entries[entries.length - 1]
  if (last !== undefined && all[all.length - 1] === last) {
    out = `${out.slice(0, last.codeEnd)},${out.slice(last.codeEnd)}`
  }
  return out
}

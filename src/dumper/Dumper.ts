/**
 * Value dumping — AdonisJS's `Dumper`, in shape and in method names.
 *
 *   import { dd } from '@c9up/ream/services/dumper'
 *   dd(user)                     // prints and stops the process
 *
 *   import dumper from '@c9up/ream/services/dumper'
 *   response.send(dumper.dumpToHtml(user, { cspNonce: response.nonce }))
 *
 * The rendering is `node:util`'s `inspect`, not a dependency. It already knows
 * about depth limits, circular references, getters, Maps, Sets and typed
 * arrays, and it colours for a terminal — which is the whole of the ANSI side.
 * The HTML side escapes that same output rather than building a second
 * formatter, so the two can never describe a value differently.
 */

import { inspect } from 'node:util'
import { escapeHTML } from '../helpers/string.js'

/** Where a dump was written, so the output can say so. */
export interface DumpSource {
  location: string
  line: number
}

/** Knobs for the terminal rendering — AdonisJS `ConsoleDumpConfig`. */
export interface ConsoleDumpConfig {
  /** How deep to walk before printing `[Object]`. Default 4. */
  depth?: number
  /** Colour the output. Default: whether stdout is a TTY. */
  colors?: boolean
  /** Show non-enumerable properties. Default false. */
  showHidden?: boolean
}

/** Knobs for the HTML rendering — AdonisJS `HTMLDumpConfig`. */
export interface HTMLDumpConfig {
  /** How deep to walk. Default 4. */
  depth?: number
  /** Show non-enumerable properties. Default false. */
  showHidden?: boolean
  /** Style overrides for the emitted `<pre>`, as CSS declarations. */
  styles?: Record<string, string>
}

const DEFAULT_STYLES: Record<string, string> = {
  'background-color': '#0b0b0d',
  color: '#e6e6e6',
  padding: '1rem',
  'border-radius': '6px',
  'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
  'font-size': '13px',
  'line-height': '1.5',
  'overflow-x': 'auto',
}

export class Dumper {
  #html: HTMLDumpConfig = {}
  #ansi: ConsoleDumpConfig = {}

  /** Configure the HTML rendering. Chainable, as in AdonisJS. */
  configureHtmlOutput(config: HTMLDumpConfig): this {
    this.#html = { ...this.#html, ...config }
    return this
  }

  /** Configure the terminal rendering. Chainable, as in AdonisJS. */
  configureAnsiOutput(config: ConsoleDumpConfig): this {
    this.#ansi = { ...this.#ansi, ...config }
    return this
  }

  /**
   * The `<style>` a page needs before its first HTML dump.
   *
   * Takes a CSP nonce because a page that sets a nonce-based policy rejects an
   * unattributed inline `<style>` — and a dump landing in a page that silently
   * drops its styling is worse than no dump. `response.nonce` is what to pass.
   */
  getHeadElements(cspNonce?: string): string {
    const nonce = cspNonce ? ` nonce="${escapeHTML(cspNonce)}"` : ''
    const styles = { ...DEFAULT_STYLES, ...this.#html.styles }
    const declarations = Object.entries(styles)
      .map(([property, value]) => `  ${property}: ${value};`)
      .join('\n')
    return `<style${nonce}>\n.ream-dump {\n${declarations}\n}\n</style>`
  }

  /** Render `value` for a terminal. */
  dumpToAnsi(value: unknown, options?: { title?: string; source?: DumpSource }): string {
    const body = inspect(value, {
      depth: this.#ansi.depth ?? 4,
      colors: this.#ansi.colors ?? process.stdout.isTTY === true,
      showHidden: this.#ansi.showHidden ?? false,
      // Long strings and arrays are the reason someone is dumping; truncating
      // them defeats the call.
      maxStringLength: null,
      maxArrayLength: null,
    })
    return [header(options), body].filter(Boolean).join('\n')
  }

  /**
   * Render `value` as HTML.
   *
   * The inspected output is escaped before it reaches the page: a dumped value
   * is by definition data someone else may control, and a dump is something
   * you reach for while debugging — exactly when a script tag in a field name
   * would be least expected.
   */
  dumpToHtml(
    value: unknown,
    options?: { cspNonce?: string; title?: string; source?: DumpSource },
  ): string {
    const body = inspect(value, {
      depth: this.#html.depth ?? 4,
      colors: false,
      showHidden: this.#html.showHidden ?? false,
      maxStringLength: null,
      maxArrayLength: null,
    })
    const heading = header(options)
    const label = heading ? `<div class="ream-dump-header">${escapeHTML(heading)}</div>` : ''
    return `${this.getHeadElements(options?.cspNonce)}\n${label}<pre class="ream-dump">${escapeHTML(body)}</pre>`
  }

  /**
   * Dump and die — print to stderr and stop the process.
   *
   * `traceSourceIndex` selects which stack frame to report as the dump site:
   * 1 is the caller of `dd`, which is right when `dd` is called directly, and
   * a wrapper passes 2.
   */
  dd(value: unknown, traceSourceIndex = 1): void {
    process.stderr.write(`${this.dumpToAnsi(value, { source: callSite(traceSourceIndex) })}\n`)
    process.exit(1)
  }
}

/** `title` and `source` as one line, or nothing when neither is given. */
function header(options?: { title?: string; source?: DumpSource }): string {
  const parts: string[] = []
  if (options?.title) parts.push(options.title)
  if (options?.source) parts.push(`${options.source.location}:${options.source.line}`)
  return parts.join(' — ')
}

/**
 * Where `dd` was called, read from a thrown stack.
 *
 * Best-effort: a bundled or minified frame may not parse, and a dump that
 * cannot name its own line is still a useful dump — so a miss returns nothing
 * rather than throwing on the debugging path.
 */
function callSite(index: number): DumpSource | undefined {
  const frames = new Error().stack?.split('\n').slice(1)
  const frame = frames?.[index]
  if (!frame) return undefined
  const match = /\(?(.+):(\d+):\d+\)?$/.exec(frame.trim())
  const location = match?.[1]
  const line = match?.[2]
  if (!location || !line) return undefined
  return { location, line: Number(line) }
}

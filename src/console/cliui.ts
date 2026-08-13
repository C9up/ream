/**
 * Terminal UI (Ace / `@poppinss/cliui` surface).
 *
 * Everything renders through {@link Ui.write}, which is what makes the layer
 * testable: in `raw` mode nothing reaches the terminal and every line is kept
 * in memory for assertions. Colours become `name(text)` there — the same trick
 * Ace uses, so an expected log stays a readable string instead of a soup of
 * escape codes.
 */

import { stdout } from 'node:process'
import { ReamError } from '../errors/ReamError.js'

/** Style names, in kleur's spelling. */
const STYLES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  grey: 90,
  bgRed: 41,
  bgGreen: 42,
  bgYellow: 43,
  bgBlue: 44,
} as const

export type StyleName = keyof typeof STYLES

/**
 * A chainable colour function.
 *
 * Called with text it renders; called with nothing it returns itself, which is
 * what allows Ace's `colors.bgGreen().white(' CREATED ')`.
 */
export type Colors = ((text?: string) => string & Colors) & { [K in StyleName]: Colors }

/** Colour is opt-out via NO_COLOR and skipped when piped to a file. */
function coloursEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true
  return Boolean(stdout.isTTY)
}

/**
 * The styles were just attached, so this always holds — it is a guard rather
 * than a cast because a cast is how a wrong assumption becomes a runtime
 * surprise somewhere else.
 */
function carriesStyles(value: object): value is Colors {
  return typeof value === 'function' && 'red' in value && 'bold' in value
}

function buildColors(applied: readonly StyleName[], isRaw: () => boolean): Colors {
  const render = (text: string): string => {
    // Raw mode spells the styles out — `blue(info)` — so a test asserts on
    // something a human can read and diff.
    if (isRaw()) {
      return applied.reduceRight((inner, style) => `${style}(${inner})`, text)
    }
    if (!coloursEnabled() || applied.length === 0) return text
    const open = applied.map((style) => `\u001B[${STYLES[style]}m`).join('')
    return `${open}${text}\u001B[0m`
  }

  const callable = (text?: string): unknown =>
    text === undefined ? buildColors(applied, isRaw) : render(text)

  const descriptors: PropertyDescriptorMap = {}
  for (const style of Object.keys(STYLES)) {
    if (!isStyleName(style)) continue
    descriptors[style] = {
      configurable: true,
      get: () => buildColors([...applied, style], isRaw),
    }
  }
  Object.defineProperties(callable, descriptors)

  if (!carriesStyles(callable)) {
    throw new Error('unreachable: the style accessors were just defined')
  }
  return callable
}

/** `Object.keys` widens to `string`; this narrows it back against the table. */
function isStyleName(value: string): value is StyleName {
  return Object.hasOwn(STYLES, value)
}

/** Where a line goes when the UI is not in raw mode. */
type Stream = 'stdout' | 'stderr'

/**
 * The console UI: colours, logger and widgets, plus the mode switch that makes
 * all of it assertable.
 */
/** One captured line, with the stream it would have gone to. */
export interface CapturedLog {
  message: string
  stream: Stream
}

export class Ui {
  #mode: 'normal' | 'raw' = 'normal'
  readonly #logs: CapturedLog[] = []
  readonly #tableRows: string[][] = []
  #tableHead: string[] = []

  readonly colors: Colors = buildColors([], () => this.#mode === 'raw')
  readonly logger: Logger

  constructor() {
    this.logger = new Logger(this)
  }

  /** `raw` keeps every line in memory instead of printing it. */
  switchMode(mode: 'normal' | 'raw'): void {
    this.#mode = mode
    if (mode === 'raw') {
      this.#logs.length = 0
      this.#tableRows.length = 0
      this.#tableHead = []
    }
  }

  get mode(): 'normal' | 'raw' {
    return this.#mode
  }

  /** Everything written since raw mode was switched on. */
  getLogs(): string[] {
    return this.#logs.map((entry) => entry.message)
  }

  /** The same lines with the stream each one targeted. */
  getCapturedLogs(): CapturedLog[] {
    return [...this.#logs]
  }

  /**
   * Table rows as they were given, before padding.
   *
   * Assertions compare data, not layout: `assertTableRows` should not break
   * because a column grew wider.
   */
  getTableRows(): string[][] {
    return this.#tableRows.map((row) => [...row])
  }

  /** @internal Recorded by {@link Table.render}. */
  captureTableRow(cells: readonly string[]): void {
    if (this.#mode === 'raw') this.#tableRows.push([...cells])
  }

  /** @internal The head row, kept apart from the data rows. */
  captureTableHead(cells: readonly string[]): void {
    if (this.#mode === 'raw') this.#tableHead = [...cells]
  }

  /**
   * The header cells of the last rendered table.
   *
   * Kept apart from {@link getTableRows} so a caller can assert the data alone.
   * `assertTableRows` looks at both: Ace treats the head as one more row, and a
   * test may or may not restate it.
   */
  getTableHead(): string[] {
    return [...this.#tableHead]
  }

  /** The single sink every widget writes through. */
  write(line: string, stream: Stream = 'stdout'): void {
    if (this.#mode === 'raw') {
      this.#logs.push({ message: line, stream })
      return
    }
    const target = stream === 'stderr' ? process.stderr : stdout
    target.write(`${line}\n`)
  }

  table(): Table {
    return new Table(this)
  }

  sticker(): Box {
    return new Box(this, 'sticker')
  }

  instructions(): Box {
    return new Box(this, 'instructions')
  }

  tasks(options: TasksOptions = {}): Tasks {
    return new Tasks(this, options)
  }
}

/**
 * Command logger.
 *
 * Alert levels go to stderr so a command's data output stays pipeable — a
 * warning must not end up inside `ream list --json | jq`.
 */
export class Logger {
  readonly #ui: Ui
  #prefixText = ''
  #suffixText = ''

  constructor(ui: Ui) {
    this.#ui = ui
  }

  /**
   * Prepend a fixed marker to EVERY message from now on.
   *
   * Ace's own `prefix` is per-message (`info(msg, { prefix })`, supported
   * below); this sticky form is kept because a command tagging all its output
   * should not repeat itself on every call.
   */
  prefix(value: string): this {
    this.#prefixText = value
    return this
  }

  suffix(value: string): this {
    this.#suffixText = value
    return this
  }

  info(message: string, options: MessageOptions = {}): void {
    this.#write('info', 'blue', message, 'stdout', options)
  }

  success(message: string, options: MessageOptions = {}): void {
    this.#write('success', 'green', message, 'stdout', options)
  }

  warning(message: string, options: MessageOptions = {}): void {
    this.#write('warn', 'yellow', message, 'stderr', options)
  }

  error(message: string | Error, options: MessageOptions = {}): void {
    this.#write('error', 'red', messageOf(message), 'stderr', options)
  }

  /**
   * A message with animated trailing dots (Ace `logger.await`).
   *
   * The animation only ticks on a TTY: on a pipe, or in raw mode, one line per
   * frame would be noise in a log and unassertable in a test.
   */
  await(message: string, options: MessageOptions = {}): Animation {
    return new Animation(this.#ui, message, options)
  }

  fatal(message: string | Error): void {
    this.error(message)
    if (message instanceof Error && message.stack !== undefined) {
      this.#ui.write(this.#ui.colors.dim(message.stack), 'stderr')
    }
  }

  /** Only prints when DEBUG is set — the usual escape hatch for noisy detail. */
  debug(message: string): void {
    if (process.env.DEBUG === undefined || process.env.DEBUG === '') return
    this.#write('debug', 'magenta', message, 'stdout')
  }

  /** A line with no decoration. Use it for the command's own output. */
  log(message: string): void {
    this.#ui.write(message)
  }

  /**
   * A step whose outcome is reported later (Ace `logger.action`).
   *
   *   const create = this.logger.action('creating config/auth.ts')
   *   try { … ; create.displayDuration().succeeded() }
   *   catch (error) { create.failed(error) }
   */
  action(title: string): Action {
    return new Action(this.#ui, title)
  }

  #write(
    label: string,
    colour: StyleName,
    message: string,
    stream: Stream,
    options: MessageOptions = {},
  ): void {
    const tag = this.#ui.colors[colour](label)
    // Per-message prefix/suffix win over the sticky ones.
    const prefix = options.prefix === undefined ? this.#prefixText : String(options.prefix)
    const suffix = options.suffix === undefined ? this.#suffixText : String(options.suffix)
    const parts = [
      prefix === '' ? '' : this.#ui.colors.dim(prefix),
      `[ ${tag} ]`,
      message,
      suffix === '' ? '' : this.#ui.colors.dim(suffix),
    ].filter((part) => part !== '')
    this.#ui.write(parts.join(' '), stream)
  }
}

/** Per-message decoration (Ace `logger.info(msg, { prefix, suffix })`). */
export interface MessageOptions {
  prefix?: string | number
  suffix?: string | number
}

/**
 * An "in progress" message with animated dots (Ace `logger.await`).
 *
 * Only animates on a TTY. Elsewhere it prints the message once and each
 * `update` once more, which keeps logs and test assertions readable.
 */
export class Animation {
  readonly #ui: Ui
  #message: string
  #options: MessageOptions
  #timer: ReturnType<typeof setInterval> | undefined
  #frame = 0

  constructor(ui: Ui, message: string, options: MessageOptions) {
    this.#ui = ui
    this.#message = message
    this.#options = options
  }

  start(): this {
    this.#print()
    if (this.#animatable()) {
      this.#timer = setInterval(() => {
        this.#frame = (this.#frame + 1) % 4
        this.#redraw()
      }, 300)
      // Never hold the process open for a decoration.
      this.#timer.unref?.()
    }
    return this
  }

  update(message: string, options: MessageOptions = {}): this {
    this.#message = message
    this.#options = options
    this.#frame = 0
    if (this.#animatable()) this.#redraw()
    else this.#print()
    return this
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
      stdout.write('\n')
    }
  }

  #animatable(): boolean {
    return this.#ui.mode === 'normal' && Boolean(stdout.isTTY)
  }

  #line(): string {
    const dots = '.'.repeat(this.#frame)
    const suffix =
      this.#options.suffix === undefined
        ? ''
        : ` ${this.#ui.colors.dim(String(this.#options.suffix))}`
    const prefix =
      this.#options.prefix === undefined
        ? ''
        : `${this.#ui.colors.dim(String(this.#options.prefix))} `
    return `${prefix}${this.#message}${dots}${suffix}`
  }

  #print(): void {
    this.#ui.write(this.#line())
  }

  #redraw(): void {
    // Rewrite in place instead of stacking a line per frame.
    stdout.write(`\r\u001B[2K${this.#line()}`)
  }
}

/** A pending action, reported through one of its terminal methods. */
export class Action {
  readonly #ui: Ui
  readonly #title: string
  readonly #startedAt: number
  #withDuration = false

  constructor(ui: Ui, title: string, startedAt = Date.now()) {
    this.#ui = ui
    this.#title = title
    this.#startedAt = startedAt
  }

  /** Append how long the action took. */
  displayDuration(): this {
    this.#withDuration = true
    return this
  }

  succeeded(): void {
    this.#report(this.#ui.colors.green('DONE'), 'stdout')
  }

  skipped(reason?: string): void {
    const suffix = reason === undefined ? '' : ` (${reason})`
    this.#report(`${this.#ui.colors.yellow('SKIPPED')}${suffix}`, 'stdout')
  }

  failed(error: unknown): void {
    this.#report(`${this.#ui.colors.red('FAILED')} ${messageOf(error)}`, 'stderr')
  }

  #report(status: string, stream: Stream): void {
    const duration = this.#withDuration ? ` ${this.#ui.colors.dim(`(${this.#elapsed()})`)}` : ''
    this.#ui.write(`${status} ${this.#title}${duration}`, stream)
  }

  #elapsed(): string {
    const ms = Date.now() - this.#startedAt
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
  }
}

/** A cell with its alignment (Ace `{ content, hAlign }`). */
export interface TableCell {
  content: string
  hAlign?: 'left' | 'right' | 'center'
}

export type TableInput = string | TableCell

/** A column-aligned table (Ace `ui.table()`). */
export class Table {
  readonly #ui: Ui
  #headCells: TableCell[] = []
  readonly #rows: TableCell[][] = []
  #full = false
  #fluidColumn = 0

  constructor(ui: Ui) {
    this.#ui = ui
  }

  head(columns: readonly TableInput[]): this {
    this.#headCells = columns.map(toCell)
    return this
  }

  row(cells: readonly TableInput[]): this {
    this.#rows.push(cells.map(toCell))
    return this
  }

  /**
   * Stretch the table to the terminal width, the first column absorbing the
   * slack (Ace `fullWidth`). Falls back to content width when the width is
   * unknown — a pipe has no columns.
   */
  fullWidth(): this {
    this.#full = true
    return this
  }

  /**
   * Which column absorbs the slack in full-width mode (Ace
   * `fluidColumnIndex`). Defaults to the first.
   */
  fluidColumnIndex(index: number): this {
    // A negative or fractional index would make `fullWidth()` silently do
    // nothing — the kind of failure that is noticed three screens later.
    if (!Number.isInteger(index) || index < 0) {
      throw new ReamError(
        'E_CONSOLE_INVALID_COLUMN',
        `fluidColumnIndex(${index}) is not a column position.`,
        { hint: 'Pass a zero-based integer index.' },
      )
    }
    this.#fluidColumn = index
    return this
  }

  render(): void {
    const all = this.#headCells.length > 0 ? [this.#headCells, ...this.#rows] : this.#rows
    if (all.length === 0) return

    // Widths are measured on the VISIBLE text: a cell coloured with
    // `colors.green('DONE')` carries escape codes that must not shift columns.
    const columns = Math.max(...all.map((row) => row.length))
    const widths = Array.from({ length: columns }, (_, index) =>
      Math.max(...all.map((row) => visibleWidth(row[index]?.content ?? ''))),
    )

    if (this.#full) {
      // Known only now: the column count comes from the rows.
      if (this.#fluidColumn >= columns) {
        throw new ReamError(
          'E_CONSOLE_INVALID_COLUMN',
          `fluidColumnIndex(${this.#fluidColumn}) is out of range — the table has ${columns} column(s).`,
        )
      }
      const available = stdout.columns ?? 0
      const used = widths.reduce((total, width) => total + width, 0) + (columns - 1) * 2
      // Only ever grows the fluid column; shrinking would truncate content.
      const fluid = this.#fluidColumn
      if (available > used && widths[fluid] !== undefined) widths[fluid] += available - used
    }

    const line = (cells: readonly TableCell[]): string =>
      cells
        .map((cell, index) => align(cell, widths[index] ?? 0))
        .join('  ')
        .trimEnd()

    if (this.#headCells.length > 0) {
      this.#ui.write(
        line(
          this.#headCells.map((cell) => ({
            ...cell,
            content: this.#ui.colors.bold(cell.content),
          })),
        ),
      )
      this.#ui.write(widths.map((width) => '─'.repeat(width)).join('  '))
      this.#ui.captureTableHead(this.#headCells.map((cell) => cell.content))
    }
    for (const row of this.#rows) {
      this.#ui.write(line(row))
      // Recorded unpadded: an assertion compares data, not layout.
      this.#ui.captureTableRow(row.map((cell) => cell.content))
    }
  }
}

function toCell(input: TableInput): TableCell {
  return typeof input === 'string' ? { content: input } : { ...input }
}

/** Pad a cell to `width`, honouring its horizontal alignment. */
function align(cell: TableCell, width: number): string {
  const slack = Math.max(0, width - visibleWidth(cell.content))
  if (cell.hAlign === 'right') return ' '.repeat(slack) + cell.content
  if (cell.hAlign === 'center') {
    const left = Math.floor(slack / 2)
    return ' '.repeat(left) + cell.content + ' '.repeat(slack - left)
  }
  return cell.content + ' '.repeat(slack)
}

/**
 * A bordered box — `sticker()` for a highlighted block, `instructions()` for a
 * decorated list of steps.
 */
export class Box {
  readonly #ui: Ui
  readonly #kind: 'sticker' | 'instructions'
  readonly #lines: string[] = []

  constructor(ui: Ui, kind: 'sticker' | 'instructions') {
    this.#ui = ui
    this.#kind = kind
  }

  add(line: string): this {
    this.#lines.push(line)
    return this
  }

  render(): void {
    if (this.#lines.length === 0) return

    // Instructions are steps, marked with a pointer as Ace renders them; a
    // sticker is a plain highlighted block.
    const decorated =
      this.#kind === 'instructions'
        ? this.#lines.map((line) => (line === '' ? line : `${this.#ui.colors.dim('>')} ${line}`))
        : this.#lines

    const width = Math.max(...decorated.map(visibleWidth))
    const border = this.#ui.colors.dim('─'.repeat(width + 2))

    this.#ui.write(`${this.#ui.colors.dim('┌')}${border}${this.#ui.colors.dim('┐')}`)
    for (const line of decorated) {
      this.#ui.write(`${this.#ui.colors.dim('│')} ${pad(line, width)} ${this.#ui.colors.dim('│')}`)
    }
    this.#ui.write(`${this.#ui.colors.dim('└')}${border}${this.#ui.colors.dim('┘')}`)
  }
}

/** Handed to a task callback so it can report progress and failure. */
export class TaskContext {
  readonly #ui: Ui
  readonly #title: string
  readonly #verbose: boolean
  #lastMessage = ''
  #failure: Error | undefined

  constructor(ui: Ui, title: string, verbose = false) {
    this.#ui = ui
    this.#title = title
    this.#verbose = verbose
  }

  /**
   * Report progress.
   *
   * Verbose prints every message; minimal keeps only the last one, surfaced on
   * the task's final line. A progress loop otherwise floods the output with a
   * line per percent.
   */
  update(message: string): void {
    this.#lastMessage = message
    if (this.#verbose) {
      this.#ui.write(`  ${this.#ui.colors.dim(`${this.#title}: ${message}`)}`)
    }
  }

  /** @internal The last progress message, shown when the task ends. */
  get lastMessage(): string {
    return this.#lastMessage
  }

  /**
   * Mark the task as failed. Returned from the callback rather than thrown, so
   * an expected failure reads like a value — Ace's `return task.error(…)`.
   */
  error(reason: string | Error): Error {
    this.#failure = reason instanceof Error ? reason : new Error(reason)
    return this.#failure
  }

  /** @internal */
  get failure(): Error | undefined {
    return this.#failure
  }
}

export interface TaskOutcome {
  title: string
  state: 'succeeded' | 'failed'
  message: string
  error?: Error
}

/**
 * A sequence of steps with their outcome (Ace `ui.tasks()`).
 *
 * Sequential on purpose: the point is a readable progress report, and running
 * them concurrently would interleave the lines into noise. A failing task stops
 * the run — the ones after it usually depend on it.
 */
export interface TasksOptions {
  /**
   * Print every progress message instead of only the last one.
   *
   * Minimal is the default, as in Ace: a hundred `Downloaded 42%` lines make a
   * transcript unreadable. Verbose is what a `--verbose` flag turns on.
   */
  verbose?: boolean
}

export class Tasks {
  readonly #ui: Ui
  readonly #verbose: boolean
  readonly #entries: Array<{ title: string; work: (task: TaskContext) => Promise<unknown> }> = []
  readonly #outcomes: TaskOutcome[] = []

  constructor(ui: Ui, options: TasksOptions = {}) {
    this.#ui = ui
    this.#verbose = options.verbose === true
  }

  add(title: string, work: (task: TaskContext) => Promise<unknown>): this {
    this.#entries.push({ title, work })
    return this
  }

  /** Results in declaration order, including the task that failed. */
  get outcomes(): TaskOutcome[] {
    return [...this.#outcomes]
  }

  async run(): Promise<TaskOutcome[]> {
    for (const entry of this.#entries) {
      const context = new TaskContext(this.#ui, entry.title, this.#verbose)
      let message = ''
      let failure: Error | undefined

      try {
        const returned = await entry.work(context)
        failure = context.failure ?? (returned instanceof Error ? returned : undefined)
        if (failure === undefined) {
          message = returned === undefined ? context.lastMessage : String(returned)
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err))
      }

      if (failure === undefined) {
        this.#outcomes.push({ title: entry.title, state: 'succeeded', message })
        this.#ui.write(
          `${this.#ui.colors.green('✔')} ${entry.title}` +
            (message === '' ? '' : ` ${this.#ui.colors.dim(message)}`),
        )
        continue
      }

      this.#outcomes.push({
        title: entry.title,
        state: 'failed',
        message: failure.message,
        error: failure,
      })
      this.#ui.write(
        `${this.#ui.colors.red('✖')} ${entry.title} ${this.#ui.colors.dim(failure.message)}`,
        'stderr',
      )
      // Stop here: later steps normally build on this one.
      break
    }

    return this.outcomes
  }
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

/** Width without ANSI escapes, so colour never shifts a column. */
function visibleWidth(text: string): number {
  return stripAnsi(text).length
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)))
}

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

/**
 * The exception `dd()` throws — AdonisJS's `E_DUMP_DIE_EXCEPTION`.
 *
 * Dump-and-die stops the piece of work it is called from, never the process:
 * during a request the HTTP exception handler hands the exception its own
 * `handle()`, which answers THAT request with the dump; in a command the
 * console kernel calls its `render()`, which prints the dump and fails the
 * command. A `process.exit` here would have turned a `dd` left on a rarely
 * used path into a remote kill switch for every client of the server.
 */

import { inspect } from 'node:util'
import { Exception } from '../http/Exception.js'
import type { HttpContext } from '../http/HttpContext.js'
import type { Dumper, DumpSource } from './Dumper.js'

/** The slice of the console kernel the ANSI rendering writes through. */
interface DumpKernel {
  ui: { logger: { log(message: string): unknown } }
}

export class DumpDieException extends Exception {
  static override status = 500
  // An upstream identifier, kept verbatim (the `E_<PKG>_<REASON>` exception).
  static override code = 'E_DUMP_DIE_EXCEPTION'

  readonly #dumper: Dumper
  #traceSourceIndex = 1
  readonly value: unknown

  constructor(value: unknown, dumper: Dumper) {
    super('Dump and Die exception')
    // Drop the constructor frames, so frame 0 is `Dumper.dd` and the trace
    // index counts from there whatever the exception hierarchy looks like.
    Error.captureStackTrace(this, DumpDieException)
    this.#dumper = dumper
    this.value = value
  }

  /**
   * Which stack frame names the dump site: 1 is the caller of `dd`, a helper
   * built on top of it passes one more per wrapping frame.
   */
  setTraceSourceIndex(index: number): this {
    this.#traceSourceIndex = index
    return this
  }

  /** Never reported: a dump is a developer's deliberate stop, not a failure. */
  report(): void {}

  /** Answer the current request with the dump, as a 500 HTML page. */
  async handle(error: this, ctx: HttpContext): Promise<void> {
    const cspNonce = ctx.response.nonce
    const dump = this.#dumper.dumpToHtml(error.value, {
      cspNonce,
      source: this.#source(),
      title: 'DUMP DIE',
    })
    ctx.response
      .status(500)
      .type('text/html; charset=utf-8')
      .send(
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width"><title>DUMP DIE</title></head>' +
          `<body>${dump}</body></html>`,
      )
  }

  /** Print the dump in a command, through the kernel's logger. */
  async render(error: this, kernel: DumpKernel): Promise<void> {
    kernel.ui.logger.log(
      this.#dumper.dumpToAnsi(error.value, { source: this.#source(), title: 'DUMP DIE' }),
    )
  }

  /** An uncaught dump still prints the value rather than the exception. */
  [inspect.custom](): string {
    return this.#dumper.dumpToAnsi(this.value, { source: this.#source(), title: 'DUMP DIE' })
  }

  /**
   * The dump site, read from this exception's own stack. Frame 0 is `dd`
   * inside the dumper, so index 1 is its caller.
   *
   * Best-effort: a bundled or minified frame may not parse, and a dump that
   * cannot name its own line is still a useful dump.
   */
  #source(): DumpSource | undefined {
    const frames = (this.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
    const frame = frames[this.#traceSourceIndex]
    if (!frame) return undefined
    const match = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(frame.trim())
    const location = match?.[1]
    const line = match?.[2]
    if (!location || !line) return undefined
    return { location, line: Number(line) }
  }
}

export const E_DUMP_DIE_EXCEPTION = DumpDieException

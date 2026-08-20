/**
 * The default renderer for a failure of the command line (Console's
 * `ExceptionHandler`).
 *
 * A class rather than a function so an application can extend it and override
 * one step — the usual need is "report this error like the framework does, but
 * ship it somewhere too".
 */

import { prettyPrintError } from '../errors/prettyPrintError.js'
import { isReamError } from '../errors/ReamError.js'
import type { Kernel } from './Kernel.js'

/** Errors the console raises when a command is called wrongly. */
const CALL_ERROR_CODES = [
  'E_CONSOLE_COMMAND_NOT_FOUND',
  'E_CONSOLE_MISSING_ARGUMENT',
  'E_CONSOLE_MISSING_ARGUMENT_VALUE',
  'E_CONSOLE_MISSING_FLAG',
  'E_CONSOLE_MISSING_FLAG_VALUE',
  'E_CONSOLE_UNKNOWN_FLAG',
  'E_CONSOLE_INVALID_FLAG_VALUE',
  'E_CONSOLE_INVALID_FLAG_GROUP',
  'E_CONSOLE_UNEXPECTED_ARGUMENT',
  'E_CONSOLE_PROMPT_CANCELLED',
]

export class ExceptionHandler {
  /** Print the whole error, stack included. */
  debug = true

  /**
   * Error codes to report as a single line, without a stack.
   *
   * The framework's own call errors are always in this set: a missing flag is
   * something the user typed, and a stack trace of the parser tells them
   * nothing about it.
   */
  knownErrorCodes: string[] = []

  protected get internalKnownErrorCodes(): readonly string[] {
    return CALL_ERROR_CODES
  }

  /** One line on stderr, through the kernel's own UI. */
  protected logError(message: string, kernel: Kernel): void {
    kernel.logger.error(message)
  }

  /** The full error, with its stack — what a developer needs. */
  protected async prettyPrintError(error: unknown): Promise<void> {
    prettyPrintError(error)
  }

  async render(error: unknown, kernel: Kernel): Promise<void> {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      this.logError(String(error), kernel)
      return
    }

    // An unknown command is a typo: the suggestion is the useful part, the
    // stack is noise.
    if (isReamError(error, 'E_CONSOLE_COMMAND_NOT_FOUND')) {
      this.logError(String(error.message), kernel)
      return
    }

    const code = Reflect.get(error, 'code')
    if (
      typeof code === 'string' &&
      (this.internalKnownErrorCodes.includes(code) || this.knownErrorCodes.includes(code))
    ) {
      this.logError(String(Reflect.get(error, 'message')), kernel)
      return
    }

    // An error that knows how to report itself is left to do it.
    const render = Reflect.get(error, 'render')
    if (typeof render === 'function') {
      await Reflect.apply(render, error, [error, kernel])
      return
    }

    if (!this.debug) {
      kernel.logger.fatal(error instanceof Error ? error : String(error))
      return
    }

    await this.prettyPrintError(error)
  }
}

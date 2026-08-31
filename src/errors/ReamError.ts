/**
 * Base ReamError class for TypeScript.
 *
 * Parses structured JSON errors from Rust NAPI boundary and provides
 * rich error context (code, hint, source location, docs URL).
 *
 * @implements FR71, FR72, FR73, FR77
 */

import { currentNodeEnv } from '../env/nodeEnv.js'

/**
 * Is this a Ream error, and one of these codes?
 *
 * The framework carries ONE error type with a `code`, because an error can be
 * raised in Rust and rebuilt in TypeScript across the NAPI boundary — see
 * {@link ReamError.fromNapi}. A class per code cannot cross that line, so the
 * check that replaces `instanceof MyError` is this one.
 *
 * @example
 * ```ts
 * try {
 *   await consoleApp.exec('provision')
 * } catch (error) {
 *   if (isReamError(error, 'E_CONSOLE_MISSING_FLAG', 'E_CONSOLE_MISSING_ARGUMENT')) {
 *     console.error(error.hint)   // narrowed: `error` IS a ReamError here
 *     return
 *   }
 *   throw error
 * }
 * ```
 */
export function isReamError(error: unknown): error is ReamError
export function isReamError<const Code extends string>(
  error: unknown,
  ...codes: [Code, ...Code[]]
): error is ReamError & { code: Code }
export function isReamError(error: unknown, ...codes: string[]): boolean {
  if (!(error instanceof ReamError)) return false
  return codes.length === 0 || codes.includes(error.code)
}

export class ReamError extends Error {
  /**
   * Error code: `E_<NAMESPACE>_<REASON>`.
   *
   * `E_` because every framework code carries it, so an application can filter
   * on one rule instead of remembering which convention a package followed.
   * The namespace after it says which package raised the error — without it
   * `E_FORBIDDEN` would mean three different things across the ecosystem and a
   * consumer could not tell them apart (e.g. "E_ATLAS_QUERY_ERROR",
   * "E_CONTAINER_NOT_FOUND", "E_WARDEN_UNKNOWN_POLICY").
   *
   * The exception is an identifier that already exists upstream —
   * `E_UNAUTHORIZED_ACCESS`, `E_INVALID_CREDENTIALS`, `E_VALIDATION_ERROR`.
   * Those are passed through verbatim, so code branching on one sees the same
   * string it would elsewhere, and two packages naming the same upstream
   * failure legitimately share it.
   */
  readonly code: string

  /** Additional context key-value pairs */
  readonly context: Record<string, string>

  /** Actionable hint for the developer */
  readonly hint?: string

  /** Source file where the error originated */
  readonly sourceFile?: string

  /** Line number in the source file */
  readonly sourceLine?: number

  /** URL to the error documentation page */
  readonly docsUrl?: string

  /** Pipeline stage where the error occurred (if applicable) */
  readonly pipelineStage?: string

  constructor(
    code: string,
    message: string,
    options?: {
      context?: Record<string, string>
      hint?: string
      sourceFile?: string
      sourceLine?: number
      docsUrl?: string
      pipelineStage?: string
    },
  ) {
    super(message)
    this.name = 'ReamError'
    this.code = code
    this.context = options?.context ?? {}
    this.hint = options?.hint
    this.sourceFile = options?.sourceFile
    this.sourceLine = options?.sourceLine
    this.docsUrl = options?.docsUrl ?? `https://docs.ream.dev/errors/${code}`
    this.pipelineStage = options?.pipelineStage
  }

  /**
   * Parse a NAPI error message (JSON string from Rust ReamError) into a TS ReamError.
   * Falls back to a generic error if parsing fails.
   */
  static fromNapi(error: Error): ReamError {
    try {
      const parsed = JSON.parse(error.message)
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.code !== 'string') {
        return new ReamError('E_UNKNOWN', error.message)
      }
      return new ReamError(parsed.code, parsed.message ?? error.message, {
        context:
          typeof parsed.context === 'object' && parsed.context !== null ? parsed.context : {},
        hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
        sourceFile: typeof parsed.sourceFile === 'string' ? parsed.sourceFile : undefined,
        sourceLine: typeof parsed.sourceLine === 'number' ? parsed.sourceLine : undefined,
        docsUrl: typeof parsed.docsUrl === 'string' ? parsed.docsUrl : undefined,
      })
    } catch {
      // Not a JSON error — wrap as generic
      return new ReamError('E_UNKNOWN', error.message)
    }
  }

  /**
   * Format for dev console — full box display with all details.
   */
  toDevString(): string {
    const content: string[] = []
    content.push(`[${this.code}] ${this.message}`)

    if (this.pipelineStage) {
      content.push(`Pipeline: ${this.pipelineStage}`)
    }

    if (this.sourceFile) {
      content.push(`at ${this.sourceFile}${this.sourceLine ? `:${this.sourceLine}` : ''}`)
    }

    if (Object.keys(this.context).length > 0) {
      content.push('')
      for (const [key, value] of Object.entries(this.context)) {
        // Escape newlines in values to prevent box corruption
        const safeValue = String(value).replace(/\n/g, '\\n')
        content.push(`${key}: ${safeValue}`)
      }
    }

    if (this.hint) {
      content.push('')
      content.push(`Hint: ${this.hint}`)
    }

    if (this.docsUrl) {
      content.push(`Docs: ${this.docsUrl}`)
    }

    // Compute border width from the longest content line
    const maxLen = Math.min(Math.max(...content.map((l) => l.length)) + 4, 80)
    const border = '─'.repeat(maxLen)

    const lines = [`┌${border}┐`]
    for (const line of content) {
      lines.push(`│ ${line}`)
    }
    lines.push(`└${border}┘`)

    return lines.join('\n')
  }

  /**
   * Format for prod — code + message only.
   */
  toProdString(): string {
    return `[${this.code}] ${this.message}`
  }

  /**
   * Auto-format based on NODE_ENV.
   */
  toFormattedString(): string {
    return currentNodeEnv() === 'production' ? this.toProdString() : this.toDevString()
  }
}

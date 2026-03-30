/**
 * Base ReamError class for TypeScript.
 *
 * Parses structured JSON errors from Rust NAPI boundary and provides
 * rich error context (code, hint, source location, docs URL).
 *
 * @implements FR71, FR72, FR73, FR77
 */

export class ReamError extends Error {
  /** Error code (e.g., "ATLAS_QUERY_ERROR", "CONTAINER_NOT_FOUND") */
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
        return new ReamError('UNKNOWN', error.message)
      }
      return new ReamError(parsed.code, parsed.message ?? error.message, {
        context: typeof parsed.context === 'object' && parsed.context !== null ? parsed.context : {},
        hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
        sourceFile: typeof parsed.sourceFile === 'string' ? parsed.sourceFile : undefined,
        sourceLine: typeof parsed.sourceLine === 'number' ? parsed.sourceLine : undefined,
        docsUrl: typeof parsed.docsUrl === 'string' ? parsed.docsUrl : undefined,
      })
    } catch {
      // Not a JSON error — wrap as generic
      return new ReamError('UNKNOWN', error.message)
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
    return process.env.NODE_ENV === 'production' ? this.toProdString() : this.toDevString()
  }
}

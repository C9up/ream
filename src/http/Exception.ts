/**
 * Exception system — AdonisJS-compatible exception handling.
 *
 * - Exception: base class with self-handling support
 * - ExceptionHandler: global exception handler with content negotiation
 * - Built-in E_* exceptions
 */

import { format } from 'node:util'
import { Macroable } from '../utils/Macroable.js'
import type { HttpContext } from './HttpContext.js'

/**
 * Base exception class. Extend this to create self-handling exceptions.
 *
 * Usage:
 *   throw new Exception('Something went wrong', { status: 400, code: 'E_BAD_REQUEST' })
 *
 * Self-handled exception:
 *   class PaymentFailed extends Exception {
 *     static status = 402
 *     static code = 'E_PAYMENT_FAILED'
 *     async handle(error: this, ctx: HttpContext) {
 *       ctx.response.status(402).json({ error: 'Payment failed' })
 *     }
 *     async report(error: this, ctx: HttpContext) {
 *       logger.error('Payment failed', { userId: ctx.auth.user?.id })
 *     }
 *   }
 */
export class Exception extends Error {
  static status = 500
  static code = 'E_UNKNOWN'
  /** Optional static remediation hint, copied onto instances (AdonisJS `Exception.help`). */
  static help?: string

  status: number
  code: string
  /** Human-readable remediation hint surfaced in debug output (AdonisJS `error.help`). */
  help?: string

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message)
    this.name = this.constructor.name
    // `this.constructor` is typed `Function`, which carries none of the statics
    // a subclass sets (`status`, `code`, `help`). Reading them through
    // `Reflect.get` states that we are looking at OPTIONAL statics, which is
    // exactly the contract — a subclass need not define any of them.
    const ctor = this.constructor
    const staticNumber = (key: string): number | undefined => {
      const v = Reflect.get(ctor, key)
      return typeof v === 'number' ? v : undefined
    }
    const staticString = (key: string): string | undefined => {
      const v = Reflect.get(ctor, key)
      return typeof v === 'string' ? v : undefined
    }
    this.status = options?.status ?? staticNumber('status') ?? Exception.status
    this.code = options?.code ?? staticString('code') ?? Exception.code
    const help = staticString('help')
    if (help !== undefined) this.help = help
  }

  /** Override to self-handle the exception (convert to HTTP response). */
  handle?(error: this, ctx: HttpContext): Promise<void> | void

  /** Override to report the exception (logging, monitoring). Never send HTTP from here. */
  report?(error: this, ctx: HttpContext): Promise<void> | void
}

/** A concrete Exception subclass produced by {@link createError}. */
export interface ExceptionConstructor {
  new (...args: unknown[]): Exception
  status: number
  code: string
}

/**
 * Build a reusable Exception subclass in one line (AdonisJS `createError`).
 * `message` may contain `util.format` placeholders (`%s`, `%d`) filled by the
 * constructor args:
 *
 *   const E_RESOURCE_MISSING = createError('Resource %s not found', 'E_RESOURCE_MISSING', 404)
 *   throw new E_RESOURCE_MISSING('user-42')   // → "Resource user-42 not found"
 */
export function createError(message: string, code: string, status = 500): ExceptionConstructor {
  return class extends Exception {
    static override status = status
    static override code = code
    constructor(...args: unknown[]) {
      super(format(message, ...args), { status, code })
    }
  }
}

/** A generic 500 runtime error (AdonisJS `RuntimeException`). */
export class RuntimeException extends Exception {
  static override status = 500
  static override code = 'E_RUNTIME_EXCEPTION'
}

/** Raised when a function receives invalid arguments (AdonisJS `InvalidArgumentsException`). */
export class InvalidArgumentsException extends RuntimeException {
  static override code = 'E_INVALID_ARGUMENTS'
}

// ─── Built-in exceptions ──────────────────────────────────

export class E_ROUTE_NOT_FOUND extends Exception {
  static override status = 404
  static override code = 'E_ROUTE_NOT_FOUND'

  constructor(method: string, path: string) {
    super(`Route not found: ${method} ${path}`, { status: 404, code: 'E_ROUTE_NOT_FOUND' })
  }
}

export class E_UNAUTHORIZED extends Exception {
  static override status = 401
  static override code = 'E_UNAUTHORIZED'

  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'E_UNAUTHORIZED' })
  }

  override handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(401).json({ error: { code: 'E_UNAUTHORIZED', message: this.message } })
  }
}

export class E_FORBIDDEN extends Exception {
  static override status = 403
  static override code = 'E_FORBIDDEN'

  required?: string[]

  constructor(message = 'Insufficient permissions', required?: string[]) {
    super(message, { status: 403, code: 'E_FORBIDDEN' })
    this.required = required
  }

  override handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(403).json({
      error: {
        code: 'E_FORBIDDEN',
        message: this.message,
        ...(this.required ? { required: this.required } : {}),
      },
    })
  }
}

export class E_VALIDATION_ERROR extends Exception {
  static override status = 422
  static override code = 'E_VALIDATION_ERROR'

  errors: unknown[]

  constructor(errors: unknown[]) {
    super('Validation failed', { status: 422, code: 'E_VALIDATION_ERROR' })
    this.errors = errors
  }

  override handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(422).json({ errors: this.errors })
  }
}

export class E_ROW_NOT_FOUND extends Exception {
  static override status = 404
  static override code = 'E_ROW_NOT_FOUND'

  constructor(model?: string) {
    super(model ? `${model} not found` : 'Resource not found', {
      status: 404,
      code: 'E_ROW_NOT_FOUND',
    })
  }

  override handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(404).json({ error: { code: 'E_ROW_NOT_FOUND', message: this.message } })
  }
}

export class E_HTTP_EXCEPTION extends Exception {
  constructor(message: string, status: number) {
    super(message, { status, code: 'E_HTTP_EXCEPTION' })
  }
}

/**
 * Thrown by `response.abort()` / `response.abortIf()` (AdonisJS parity). Carries
 * an arbitrary body that {@link handle} renders as-is — a string verbatim,
 * anything else as JSON.
 */
export class E_HTTP_REQUEST_ABORTED extends Exception {
  static override status = 400
  static override code = 'E_HTTP_REQUEST_ABORTED'

  readonly body: unknown

  constructor(body: unknown, status = 400) {
    super(typeof body === 'string' ? body : 'Request aborted', {
      status,
      code: 'E_HTTP_REQUEST_ABORTED',
    })
    this.body = body
  }

  override handle(_error: this, ctx: HttpContext): void {
    if (typeof this.body === 'string') {
      ctx.response.status(this.status).send(this.body)
    } else {
      ctx.response.status(this.status).json(this.body)
    }
  }
}

// ─── ExceptionHandler ─────────────────────────────────────

/**
 * Global exception handler — catches all unhandled exceptions and converts
 * them to HTTP responses.
 *
 * Extend this in your app:
 *   export default class Handler extends ExceptionHandler {
 *     protected debug = app.inDev
 *     protected ignoreStatuses = [400, 401, 404, 422]
 *   }
 *
 * Flow:
 * 1. If exception has handle() → self-handled (bypass global)
 * 2. Else → this.handle() → content negotiation (JSON or HTML)
 * 3. Then → this.report() → logging/monitoring
 */
/** Renders an HTML error page for a status (AdonisJS `StatusPageRenderer`). */
export type StatusPageRenderer = (error: unknown, ctx: HttpContext) => Promise<string> | string

/** A constructor usable in `instanceof` for {@link ExceptionHandler.ignoreExceptions}. */
export type ExceptionClass = new (...args: never[]) => Error

/** Reporting log level, keyed to `console` (AdonisJS levels: error/warn/info). */
type LogLevel = 'error' | 'warn' | 'info'

export class ExceptionHandler extends Macroable {
  protected debug: boolean
  /** Render `statusPages` (browser HTML). Defaults to production only (AdonisJS). */
  protected renderStatusPages: boolean = process.env.NODE_ENV === 'production'
  /** Status → HTML renderer, keys may be single codes or `'500..599'` ranges. */
  protected statusPages: Record<string, StatusPageRenderer> = {}
  /** Master reporting switch (AdonisJS `reportErrors`). */
  protected reportErrors = true
  protected ignoreStatuses: number[] = [400, 401, 404, 422]
  protected ignoreCodes: string[] = []
  /** Exception classes never reported (AdonisJS `ignoreExceptions`). */
  protected ignoreExceptions: ExceptionClass[] = []

  #expandedStatusPages?: Record<number, StatusPageRenderer>

  constructor(debug = false) {
    super()
    this.debug = debug
  }

  /** Whether debug detail is exposed for this request (AdonisJS — override per-ctx). */
  protected isDebuggingEnabled(_ctx: HttpContext): boolean {
    return this.debug
  }

  /** Log level for an error by status: 5xx→error, 4xx→warn, else info (AdonisJS). */
  protected getErrorLogLevel(status: number): LogLevel {
    if (status >= 500) return 'error'
    if (status >= 400) return 'warn'
    return 'info'
  }

  /** Whether an error should be reported — honours every ignore list (AdonisJS `shouldReport`). */
  protected shouldReport(error: unknown): boolean {
    if (!this.reportErrors) return false
    const { status, code } = extractErrorMeta(error)
    if (this.ignoreStatuses.includes(status)) return false
    if (this.ignoreCodes.includes(code)) return false
    if (this.ignoreExceptions.some((exception) => error instanceof exception)) return false
    return true
  }

  /** Expand `statusPages` range keys (`'500..599'`) into a per-code lookup (cached). */
  #expandStatusPages(): Record<number, StatusPageRenderer> {
    if (!this.#expandedStatusPages) {
      const expanded: Record<number, StatusPageRenderer> = {}
      for (const range of Object.keys(this.statusPages)) {
        Object.assign(expanded, parseStatusRange(range, this.statusPages[range]))
      }
      this.#expandedStatusPages = expanded
    }
    return this.#expandedStatusPages
  }

  /** Convert an exception to an HTTP response. */
  async handle(error: unknown, ctx: HttpContext): Promise<void> {
    // Self-handled errors take over entirely (duck-typed, per AdonisJS — any
    // thrown value exposing a `handle()` method, not just `Exception` instances).
    if (isSelfHandling(error)) {
      await error.handle(error, ctx)
      return
    }

    // Negotiation. DEVIATION (named): ream lists `json` FIRST, so a request
    // with no/`*/*` Accept defaults to JSON (API-first). AdonisJS lists `html`
    // first (full-stack default). Explicit `text/html` / `vnd.api+json` are
    // honoured identically.
    switch (ctx.request.accepts(['json', 'html', 'application/vnd.api+json'])) {
      case 'application/vnd.api+json':
        this.#sendJsonApiError(error, ctx)
        return
      case 'html':
        await this.#sendHtmlError(error, ctx)
        return
      default:
        this.#sendJsonError(error, ctx)
    }
  }

  /** Pick the user-facing message — full detail only in debug mode. */
  #errorMessage(error: unknown, ctx: HttpContext): string {
    if (this.isDebuggingEnabled(ctx) && error instanceof Error) return error.message
    if (error instanceof Exception) return error.message
    return 'An internal error occurred'
  }

  #sendJsonError(error: unknown, ctx: HttpContext): void {
    const { status, code } = extractErrorMeta(error)
    const payload: Record<string, unknown> = { code, message: this.#errorMessage(error, ctx) }
    if (error instanceof Exception && error.help) payload.help = error.help
    if (this.isDebuggingEnabled(ctx) && error instanceof Error && error.stack) {
      payload.stack = error.stack
    }
    ctx.response.status(status).json({ error: payload })
  }

  #sendJsonApiError(error: unknown, ctx: HttpContext): void {
    const { status, code } = extractErrorMeta(error)
    ctx.response
      .status(status)
      .type('application/vnd.api+json')
      .json({ errors: [{ title: this.#errorMessage(error, ctx), code, status: String(status) }] })
  }

  async #sendHtmlError(error: unknown, ctx: HttpContext): Promise<void> {
    const { status } = extractErrorMeta(error)
    // A registered status page wins (production browser error pages).
    if (this.renderStatusPages) {
      const renderer = this.#expandStatusPages()[status]
      if (renderer) {
        const html = await renderer(error, ctx)
        ctx.response.status(status).type('text/html; charset=utf-8').send(html)
        return
      }
    }
    const message = this.#errorMessage(error, ctx)
    ctx.response
      .status(status)
      .type('text/html; charset=utf-8')
      .send(
        `<!DOCTYPE html><html><head><title>Error ${status}</title></head>` +
          `<body><h1>${status}</h1><p>${escapeHtml(message)}</p></body></html>`,
      )
  }

  /** Log/report an exception. Override for custom monitoring. */
  async report(error: unknown, ctx: HttpContext): Promise<void> {
    if (!this.shouldReport(error)) return

    // Self-reported exceptions handle their own reporting.
    if (isSelfReporting(error)) {
      await error.report(error, ctx)
      return
    }

    // Default: log at the status-appropriate level.
    const { status } = extractErrorMeta(error)
    const level = this.getErrorLogLevel(status)
    const context = this.context(ctx)
    if (error instanceof Error) {
      console[level](`[${new Date().toISOString()}] ${error.message}`, context, error.stack)
    } else {
      console[level](`[${new Date().toISOString()}] Unknown error:`, error, context)
    }
  }

  /** Provide additional context for error reports. Override for custom data. */
  protected context(ctx: HttpContext): Record<string, unknown> {
    return {
      requestId: ctx.id,
      method: ctx.request.method(),
      url: ctx.request.url(),
      userId: ctx.auth.user?.id,
    }
  }
}

/** Extract status + code from an Exception, ReamError, or duck-typed error. */
function extractErrorMeta(error: unknown): { status: number; code: string } {
  let status = 500
  let code = 'E_UNKNOWN'
  if (error instanceof Exception) {
    status = error.status
    code = error.code
  } else if (error !== null && typeof error === 'object') {
    if ('status' in error && typeof error.status === 'number') status = error.status
    if ('code' in error && typeof error.code === 'string') code = error.code
  }
  return { status, code }
}

/** True when a thrown value self-handles via a `handle()` method (AdonisJS duck-type). */
function isSelfHandling(
  error: unknown,
): error is { handle: (error: unknown, ctx: HttpContext) => Promise<void> | void } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'handle' in error &&
    typeof error.handle === 'function'
  )
}

/** True when a thrown value self-reports via a `report()` method. */
function isSelfReporting(
  error: unknown,
): error is { report: (error: unknown, ctx: HttpContext) => Promise<void> | void } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'report' in error &&
    typeof error.report === 'function'
  )
}

/** Expand a status-page key into a per-code map: `'500..599'` → {500,…,599}, `'404'` → {404}. */
function parseStatusRange(
  range: string,
  renderer: StatusPageRenderer,
): Record<number, StatusPageRenderer> {
  const parts = range.split('..')
  const min = Number(parts[0])
  const max = Number(parts[1])
  if (parts.length === 1 && !Number.isNaN(min)) return { [min]: renderer }
  if (Number.isNaN(min) || Number.isNaN(max)) return {}
  const result: Record<number, StatusPageRenderer> = {}
  for (let status = min; status <= max; status += 1) result[status] = renderer
  return result
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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

  /**
   * Per-field failures. Named `messages` because that is what VineJS, rune and
   * AdonisJS's own validation renderers read — a handler copied from an Adonis
   * app reaches for `error.messages`.
   */
  messages: unknown[]

  constructor(messages: unknown[]) {
    super('Validation failure', { status: 422, code: 'E_VALIDATION_ERROR' })
    this.messages = messages
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
/**
 * A thrown value, normalised into the shape every renderer reads.
 *
 * AdonisJS hands this to `renderError*` / `renderValidationError*` and to the
 * status-page renderers, so an app that overrides one of them receives the same
 * object it would there — a plain record, never an `Error` subclass, because
 * what is thrown is not always one.
 */
export type HttpError = {
  message: string
  status: number
  code: string
  stack?: string
  cause?: unknown
  /** Per-field failures, on a validation error (VineJS / rune shape). */
  messages?: unknown
  /** Extra detail an exception chose to carry. */
  errors?: unknown
  /** Set when the thrown value handles its own response. */
  handle?: (error: unknown, ctx: HttpContext) => Promise<void> | void
  /** Set when the thrown value reports itself. */
  report?: (error: unknown, ctx: HttpContext) => Promise<void> | void
  /** A hint appended to the message, when the exception carries one. */
  help?: string
}

/** Renders an HTML error page for a status (AdonisJS `StatusPageRenderer`). */
export type StatusPageRenderer = (error: HttpError, ctx: HttpContext) => Promise<string> | string

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
  protected getErrorLogLevel(error: HttpError): LogLevel {
    if (error.status >= 500) return 'error'
    if (error.status >= 400) return 'warn'
    return 'info'
  }

  /** Whether an error should be reported — honours every ignore list (AdonisJS `shouldReport`). */
  protected shouldReport(error: HttpError): boolean {
    if (!this.reportErrors) return false
    if (this.ignoreStatuses.includes(error.status)) return false
    if (this.ignoreCodes.includes(error.code)) return false
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
  /**
   * Normalise any thrown value into an {@link HttpError}.
   *
   * Everything downstream — the renderers, the status pages, the report path —
   * reads this shape, so a handler override never has to re-sniff whether it
   * was handed an `Exception`, a plain object, or a string.
   */
  protected toHttpError(error: unknown): HttpError {
    // AdonisJS returns the thrown object ITSELF, filled in — not a copy. That
    // identity is load-bearing: `ignoreExceptions` matches with `instanceof`,
    // and `handle`/`report` have to stay bound to their own instance. A copy
    // would quietly break both.
    const source: object =
      typeof error === 'object' && error !== null ? error : new Error(String(error))
    const { status, code } = extractErrorMeta(error)
    const message =
      'message' in source && typeof source.message === 'string' && source.message.length > 0
        ? source.message
        : 'Internal server error'
    return Object.assign(source, { status, code, message })
  }

  /**
   * The message a client is allowed to see.
   *
   * DEVIATION (named): outside debug mode ream only echoes the message of a
   * deliberate `Exception`; anything else collapses to a generic line. AdonisJS
   * echoes `error.message` whatever was thrown, which leaks the text of driver
   * and library errors to the client.
   */
  protected publicMessage(error: HttpError, ctx: HttpContext): string {
    if (this.isDebuggingEnabled(ctx)) return error.message
    if (error.code !== 'E_UNKNOWN') return error.message
    return 'An internal error occurred'
  }

  /** Render an error as JSON. */
  async renderErrorAsJSON(error: HttpError, ctx: HttpContext): Promise<void> {
    const payload: Record<string, unknown> = {
      code: error.code,
      message: this.publicMessage(error, ctx),
    }
    if (error.help) payload.help = error.help
    if (this.isDebuggingEnabled(ctx) && error.stack) payload.stack = error.stack
    ctx.response.status(error.status).json({ error: payload })
  }

  /** Render an error as a JSON:API document. */
  async renderErrorAsJSONAPI(error: HttpError, ctx: HttpContext): Promise<void> {
    ctx.response
      .status(error.status)
      .type('application/vnd.api+json')
      .json({
        errors: [
          {
            title: this.publicMessage(error, ctx),
            code: error.code,
            status: String(error.status),
          },
        ],
      })
  }

  /** Render an error as HTML, preferring a registered status page. */
  async renderErrorAsHTML(error: HttpError, ctx: HttpContext): Promise<void> {
    if (this.renderStatusPages) {
      const renderer = this.#expandStatusPages()[error.status]
      if (renderer) {
        const html = await renderer(error, ctx)
        ctx.response.status(error.status).type('text/html; charset=utf-8').send(html)
        return
      }
    }
    const message = this.publicMessage(error, ctx)
    ctx.response
      .status(error.status)
      .type('text/html; charset=utf-8')
      .send(
        `<!DOCTYPE html><html><head><title>Error ${error.status}</title></head>` +
          `<body><h1>${error.status}</h1><p>${escapeHtml(message)}</p></body></html>`,
      )
  }

  /** Render per-field validation failures as JSON. */
  async renderValidationErrorAsJSON(error: HttpError, ctx: HttpContext): Promise<void> {
    ctx.response.status(error.status).json({ errors: error.messages })
  }

  /** Render per-field validation failures as a JSON:API document. */
  async renderValidationErrorAsJSONAPI(error: HttpError, ctx: HttpContext): Promise<void> {
    const messages = Array.isArray(error.messages) ? error.messages : []
    ctx.response
      .status(error.status)
      .type('application/vnd.api+json')
      .json({ errors: messages.map(toJsonApiValidationError) })
  }

  /** Render per-field validation failures as HTML. */
  async renderValidationErrorAsHTML(error: HttpError, ctx: HttpContext): Promise<void> {
    const messages = Array.isArray(error.messages) ? error.messages : []
    ctx.response
      .status(error.status)
      .type('text/html; charset=utf-8')
      .send(
        messages
          .map((message) => {
            const { field, text } = readValidationMessage(message)
            return `${escapeHtml(field)} - ${escapeHtml(text)}`
          })
          .join('<br />'),
      )
  }

  /**
   * Pick a renderer by content negotiation.
   *
   * DEVIATION (named): ream lists `json` FIRST, so a request with no or `*` /`*`
   * Accept defaults to JSON (API-first). AdonisJS lists `html` first
   * (full-stack default). Explicit `text/html` / `vnd.api+json` are honoured
   * identically.
   */
  async renderError(error: HttpError, ctx: HttpContext): Promise<void> {
    switch (ctx.request.accepts(['json', 'html', 'application/vnd.api+json'])) {
      case 'application/vnd.api+json':
        return this.renderErrorAsJSONAPI(error, ctx)
      case 'html':
        return this.renderErrorAsHTML(error, ctx)
      default:
        return this.renderErrorAsJSON(error, ctx)
    }
  }

  /** Pick a validation renderer by content negotiation. */
  async renderValidationError(error: HttpError, ctx: HttpContext): Promise<void> {
    switch (ctx.request.accepts(['json', 'html', 'application/vnd.api+json'])) {
      case 'application/vnd.api+json':
        return this.renderValidationErrorAsJSONAPI(error, ctx)
      case 'html':
        return this.renderValidationErrorAsHTML(error, ctx)
      default:
        return this.renderValidationErrorAsJSON(error, ctx)
    }
  }

  /** Convert an exception to an HTTP response. */
  async handle(error: unknown, ctx: HttpContext): Promise<void> {
    const httpError = this.toHttpError(error)

    // Self-handled errors take over entirely (duck-typed, per AdonisJS — any
    // thrown value exposing a `handle()` method, not just `Exception` instances).
    if (typeof httpError.handle === 'function') {
      await httpError.handle(httpError, ctx)
      return
    }

    // Validation failures have per-field detail and their own renderers. Keyed
    // on the code plus the presence of `messages`, exactly as AdonisJS does, so
    // rune's and VineJS's errors both land here.
    if (httpError.code === 'E_VALIDATION_ERROR' && httpError.messages !== undefined) {
      await this.renderValidationError(httpError, ctx)
      return
    }

    await this.renderError(httpError, ctx)
  }

  /** Log/report an exception. Override for custom monitoring. */
  async report(error: unknown, ctx: HttpContext): Promise<void> {
    const httpError = this.toHttpError(error)
    if (!this.shouldReport(httpError)) return

    // Self-reported exceptions handle their own reporting.
    if (typeof httpError.report === 'function') {
      await httpError.report(httpError, ctx)
      return
    }

    const level = this.getErrorLogLevel(httpError)
    ctx.logger[level](httpError.message, this.context(ctx))
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

/**
 * The fields a validation message carries (VineJS / rune `RuneErrorNode`).
 *
 * Read defensively: the messages come from whichever validator the app wired,
 * and a renderer must not throw while rendering someone else's error.
 */
function readValidationMessage(message: unknown): {
  field: string
  text: string
  rule: string
  meta: unknown
} {
  if (message === null || typeof message !== 'object') {
    return { field: '', text: String(message), rule: '', meta: undefined }
  }
  const field = 'field' in message && typeof message.field === 'string' ? message.field : ''
  const text = 'message' in message && typeof message.message === 'string' ? message.message : ''
  const rule = 'rule' in message && typeof message.rule === 'string' ? message.rule : ''
  const meta = 'meta' in message ? message.meta : undefined
  return { field, text, rule, meta }
}

/** One validation message, as a JSON:API error object (AdonisJS shape). */
function toJsonApiValidationError(message: unknown): Record<string, unknown> {
  const { field, text, rule, meta } = readValidationMessage(message)
  const error: Record<string, unknown> = {
    title: text,
    code: rule,
    source: { pointer: field },
  }
  if (meta !== undefined) error.meta = meta
  return error
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

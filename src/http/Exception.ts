/**
 * Exception system — AdonisJS-compatible exception handling.
 *
 * - Exception: base class with self-handling support
 * - ExceptionHandler: global exception handler with content negotiation
 * - Built-in E_* exceptions
 */

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

  status: number
  code: string

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message)
    this.name = this.constructor.name
    // biome-ignore lint/suspicious/noExplicitAny: this.constructor is typed as Function; subclass pattern requires the cast
    const ctor = this.constructor as any as typeof Exception
    this.status = options?.status ?? ctor.status
    this.code = options?.code ?? ctor.code
  }

  /** Override to self-handle the exception (convert to HTTP response). */
  handle?(error: this, ctx: HttpContext): Promise<void> | void

  /** Override to report the exception (logging, monitoring). Never send HTTP from here. */
  report?(error: this, ctx: HttpContext): Promise<void> | void
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
export class ExceptionHandler {
  protected debug: boolean
  protected ignoreStatuses: number[] = [400, 401, 404, 422]
  protected ignoreCodes: string[] = []

  constructor(debug = false) {
    this.debug = debug
  }

  /** Convert an exception to an HTTP response. */
  async handle(error: unknown, ctx: HttpContext): Promise<void> {
    // Self-handled exceptions take over entirely.
    if (error instanceof Exception && typeof error.handle === 'function') {
      await error.handle(error, ctx)
      return
    }

    const { status, code } = extractErrorMeta(error)
    const message = this.#errorMessage(error)
    if (wantsJson(ctx)) {
      this.#sendJsonError(ctx, status, code, message, error)
    } else {
      this.#sendHtmlError(ctx, status, message)
    }
  }

  /** Pick the user-facing message — full detail only in debug mode. */
  #errorMessage(error: unknown): string {
    if (this.debug && error instanceof Error) return error.message
    if (error instanceof Exception) return error.message
    return 'An internal error occurred'
  }

  #sendJsonError(
    ctx: HttpContext,
    status: number,
    code: string,
    message: string,
    error: unknown,
  ): void {
    const errorPayload: Record<string, unknown> = { code, message }
    if (this.debug && error instanceof Error && error.stack) {
      errorPayload.stack = error.stack
    }
    ctx.response.status(status).json({ error: errorPayload })
  }

  #sendHtmlError(ctx: HttpContext, status: number, message: string): void {
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
    if (error instanceof Exception) {
      if (this.ignoreStatuses.includes(error.status)) return
      if (this.ignoreCodes.includes(error.code)) return
    }

    // Self-reported exceptions
    if (error instanceof Exception && typeof error.report === 'function') {
      await error.report(error, ctx)
      return
    }

    // Default: log to stderr
    const context = this.context(ctx)
    if (error instanceof Error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`, context, error.stack)
    } else {
      console.error(`[${new Date().toISOString()}] Unknown error:`, error, context)
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

/** Content negotiation: JSON unless the client explicitly prefers HTML. */
function wantsJson(ctx: HttpContext): boolean {
  return (
    ctx.request.accepts(['json', 'html']) === 'json' ||
    (ctx.request.header('accept')?.includes('application/json') ?? false) ||
    !ctx.request.header('accept')?.includes('text/html')
  )
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

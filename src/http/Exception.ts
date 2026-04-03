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
    const ctor = this.constructor as typeof Exception
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
  static status = 404
  static code = 'E_ROUTE_NOT_FOUND'

  constructor(method: string, path: string) {
    super(`Route not found: ${method} ${path}`, { status: 404, code: 'E_ROUTE_NOT_FOUND' })
  }
}

export class E_UNAUTHORIZED extends Exception {
  static status = 401
  static code = 'E_UNAUTHORIZED'

  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'E_UNAUTHORIZED' })
  }

  handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(401).json({ error: { code: 'E_UNAUTHORIZED', message: this.message } })
  }
}

export class E_FORBIDDEN extends Exception {
  static status = 403
  static code = 'E_FORBIDDEN'

  required?: string[]

  constructor(message = 'Insufficient permissions', required?: string[]) {
    super(message, { status: 403, code: 'E_FORBIDDEN' })
    this.required = required
  }

  handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(403).json({
      error: { code: 'E_FORBIDDEN', message: this.message, ...(this.required ? { required: this.required } : {}) },
    })
  }
}

export class E_VALIDATION_ERROR extends Exception {
  static status = 422
  static code = 'E_VALIDATION_ERROR'

  errors: unknown[]

  constructor(errors: unknown[]) {
    super('Validation failed', { status: 422, code: 'E_VALIDATION_ERROR' })
    this.errors = errors
  }

  handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(422).json({ errors: this.errors })
  }
}

export class E_ROW_NOT_FOUND extends Exception {
  static status = 404
  static code = 'E_ROW_NOT_FOUND'

  constructor(model?: string) {
    super(model ? `${model} not found` : 'Resource not found', { status: 404, code: 'E_ROW_NOT_FOUND' })
  }

  handle(_error: this, ctx: HttpContext): void {
    ctx.response.status(404).json({ error: { code: 'E_ROW_NOT_FOUND', message: this.message } })
  }
}

export class E_HTTP_EXCEPTION extends Exception {
  constructor(message: string, status: number) {
    super(message, { status, code: 'E_HTTP_EXCEPTION' })
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
    // Self-handled exceptions
    if (error instanceof Exception && typeof error.handle === 'function') {
      await error.handle(error, ctx)
      return
    }

    // Extract status, code, and message — support both Exception and ReamError
    const status = error instanceof Exception ? error.status
      : (error as { status?: number }).status ?? 500
    const code = error instanceof Exception ? error.code
      : (error as { code?: string }).code ?? 'E_UNKNOWN'
    const message = this.debug && error instanceof Error
      ? error.message
      : (error instanceof Exception ? error.message : 'An internal error occurred')

    // Content negotiation
    const wantsJson = ctx.request.accepts(['json', 'html']) === 'json'
      || ctx.request.header('accept')?.includes('application/json')
      || !ctx.request.header('accept')?.includes('text/html')

    if (wantsJson) {
      const body: Record<string, unknown> = { error: { code, message } }
      if (this.debug && error instanceof Error && error.stack) {
        body.error = { ...body.error as Record<string, unknown>, stack: error.stack }
      }
      ctx.response.status(status).json(body)
    } else {
      // HTML fallback — simple error page
      ctx.response.status(status).type('text/html; charset=utf-8').send(
        `<!DOCTYPE html><html><head><title>Error ${status}</title></head>`
        + `<body><h1>${status}</h1><p>${escapeHtml(message)}</p></body></html>`,
      )
    }
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

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

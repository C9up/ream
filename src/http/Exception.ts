/**
 * Exception system — AdonisJS-compatible exception handling.
 *
 * - Exception: flare's, re-exported, with self-handling support
 * - ExceptionHandler: global exception handler with content negotiation
 * - Built-in E_* exceptions
 */

import { createError, Exception } from '@c9up/flare'
import { currentNodeEnv } from '../env/nodeEnv.js'
import { Macroable } from '../utils/Macroable.js'
import type { HttpContext } from './HttpContext.js'

/**
 * The exception classes are flare's, the ones every package of the ecosystem
 * extends: `Exception` (static `status`, `code`, `help`, `message`),
 * `createError(message, code, status?)` whose class takes the placeholder
 * values as an array, `RuntimeException`, `InvalidArgumentsException`.
 *
 * A self-handling exception declares `handle()` and `report()`; the handler
 * calls them on whatever was thrown, duck-typed:
 *
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
export {
  createError,
  type ErrorClass,
  Exception,
  InvalidArgumentsException,
  RuntimeException,
} from '@c9up/flare'

// ─── Built-in exceptions ──────────────────────────────────

/** No route matches the request's method and URL (`Cannot GET:/missing`). */
export const E_ROUTE_NOT_FOUND = createError<[method: string, url: string]>(
  'Cannot %s:%s',
  'E_ROUTE_NOT_FOUND',
  404,
)

/**
 * A route's `.auth()` guard (or its `.role()` / `.permission()` check on an
 * anonymous request) refused the request.
 *
 * The code, status, message, `identifier`, `getResponseMessage` and `handle`
 * are those of `E_UNAUTHORIZED_ACCESS` in `@c9up/warden`, so the refusal
 * answers the same bytes whichever of the two raised it, and an application
 * branches on `error.code` the same way. Ream does not depend on warden, so the
 * class is its own: test the code, not the class, across the two.
 */
export class E_UNAUTHORIZED_ACCESS extends Exception {
  static override status = 401
  static override code = 'E_UNAUTHORIZED_ACCESS'
  static override message = 'Unauthorized access'

  /** The translation key of the message (`ctx.i18n.t`). */
  readonly identifier = 'errors.E_UNAUTHORIZED_ACCESS'

  /** The message, translated through `ctx.i18n` when the request has one. */
  getResponseMessage(error: E_UNAUTHORIZED_ACCESS, ctx: HttpContext): string {
    return translate(ctx, error.identifier, {}, error.message)
  }

  /**
   * Write the refusal: `401 { error: { code, message } }`, whatever the client
   * accepts — the body warden's refusal writes for a guard with no login route
   * to redirect to and no challenge to send.
   */
  async handle(error: E_UNAUTHORIZED_ACCESS, ctx: HttpContext): Promise<void> {
    ctx.response.status(error.status)
    ctx.response.json({
      error: {
        code: error.code ?? E_UNAUTHORIZED_ACCESS.code,
        message: error.getResponseMessage(error, ctx),
      },
    })
  }
}

/**
 * A route's `.role()` or `.permission()` check refused an authenticated user.
 *
 * The code, status, message, `identifier`, `getResponseMessage` and `handle`
 * are those of `E_AUTHORIZATION_FAILURE` in `@c9up/warden` (a denied
 * `authorize()`), so the refusal answers the same bytes as warden's. The roles
 * and permissions the route asks for are not carried: the message reaches the
 * client, and the list would tell it what to obtain.
 */
export class E_AUTHORIZATION_FAILURE extends Exception {
  static override status = 403
  static override code = 'E_AUTHORIZATION_FAILURE'
  static override message = 'Access denied'

  /** The translation key of the message (`ctx.i18n.t`). */
  readonly identifier = 'errors.E_AUTHORIZATION_FAILURE'

  /** The message, translated through `ctx.i18n` when the request has one. */
  getResponseMessage(ctx: HttpContext): string {
    return translate(ctx, this.identifier, {}, this.message)
  }

  /**
   * Write the denial by content negotiation: a form submission (POST, PUT,
   * PATCH, DELETE) from a browser with a session gets the form flashed back
   * (without `_csrf`, `_method` and passwords), the message flashed, and a
   * redirect back; any other HTML request the message as text;
   * `{ errors: [{ message }] }` for JSON; a JSON:API error object.
   */
  async handle(_: unknown, ctx: HttpContext): Promise<void> {
    const message = this.getResponseMessage(ctx)
    const code = E_AUTHORIZATION_FAILURE.code
    switch (ctx.request.accepts(['html', 'application/vnd.api+json', 'json'])) {
      case 'json':
        ctx.response.status(this.status)
        ctx.response.send({ errors: [{ message }] })
        return
      case 'application/vnd.api+json':
        ctx.response.status(this.status)
        ctx.response.send({ errors: [{ code, title: message }] })
        return
    }
    const session = ctx.session
    if (session && FORM_SUBMISSION_METHODS.includes(ctx.request.method().toUpperCase())) {
      session.flashExcept([
        '_csrf',
        '_method',
        'password',
        'password_confirmation',
        'passwordConfirmation',
      ])
      session.flash('error', message)
      session.flashErrors({ [code]: message })
      ctx.response.redirect('back', true)
      return
    }
    ctx.response.status(this.status)
    ctx.response.send(message)
  }
}

/**
 * A controller action declared `@RequireMfa()` was reached with a credential
 * that did not complete the multi-factor step-up (`ctx.auth.user.mfa` is not
 * `true`).
 *
 * NAMED DEVIATION from the `E_<PKG>_<REASON>` rule: the code is the one
 * `@c9up/warden` answers with, under warden's name. The decorator is
 * warden's, and its middleware and ream's route gate both enforce it: the
 * refusal has to read the same whichever of the two raised it — same status,
 * same code, same message, same body — so an application branches on one
 * code. Ream does not depend on warden, so the class is its own: test the
 * code, not the class, across the two.
 */
export class E_WARDEN_MFA_REQUIRED extends Exception {
  static override status = 403
  static override code = 'E_WARDEN_MFA_REQUIRED'
  static override message = 'Multi-factor authentication is required for this action.'

  /** Write the refusal: `403 { error: { code, message } }`, whatever the client accepts. */
  async handle(error: E_WARDEN_MFA_REQUIRED, ctx: HttpContext): Promise<void> {
    ctx.response.status(error.status)
    ctx.response.json({
      error: {
        code: error.code ?? E_WARDEN_MFA_REQUIRED.code,
        message: error.message,
      },
    })
  }
}

/** The methods of a form submission, which a denial redirects back from. */
const FORM_SUBMISSION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

/**
 * `identifier` translated through the request's i18n service
 * (`ctx.i18n.t(identifier, data, { defaultValue })`, the shape of the
 * ecosystem's i18n package), `fallback` without one. Read structurally: ream
 * does not depend on the i18n package.
 */
function translate(
  ctx: HttpContext,
  identifier: string,
  data: Record<string, unknown>,
  fallback: string,
): string {
  const i18n: unknown = Reflect.get(ctx, 'i18n')
  if (typeof i18n !== 'object' || i18n === null) return fallback
  const t: unknown = Reflect.get(i18n, 't')
  if (typeof t !== 'function') return fallback
  const translated: unknown = Reflect.apply(t, i18n, [identifier, data, { defaultValue: fallback }])
  return typeof translated === 'string' ? translated : fallback
}

/**
 * A route validator rejected the request body. The same shape as
 * `E_VALIDATION_ERROR` in `@c9up/rune` (code, status 422, message, the
 * per-field `messages`), which ream does not depend on: the exception handler
 * keys its validation renderers on the code and `messages`, so both render the
 * same way.
 */
export class E_VALIDATION_ERROR extends Exception {
  static override status = 422
  static override code = 'E_VALIDATION_ERROR'
  static override message = 'Validation failure'

  /** Per-field failures, as the validator reported them. */
  readonly messages: unknown[]

  constructor(messages: unknown[], options?: ErrorOptions) {
    super(undefined, options)
    this.messages = messages
  }
}

/**
 * An exception that carries the body of the response it turns into.
 * `E_HTTP_EXCEPTION.invoke(body, status)` builds one from a string, an object
 * (its `message` becomes the error's) or nothing at all.
 */
export class E_HTTP_EXCEPTION extends Exception {
  static override code = 'E_HTTP_EXCEPTION'

  /** What is sent to the client. */
  body: unknown

  static invoke(body: unknown, status: number, code = 'E_HTTP_EXCEPTION'): E_HTTP_EXCEPTION {
    if (body === null || body === undefined) {
      const error = new this('HTTP Exception', { status, code })
      error.body = 'Internal server error'
      return error
    }
    if (typeof body === 'object') {
      const message: unknown = Reflect.get(body, 'message')
      const error = new this(
        typeof message === 'string' && message.length > 0 ? message : 'HTTP Exception',
        { status, code },
      )
      error.body = body
      return error
    }
    const error = new this(String(body), { status, code })
    error.body = body
    return error
  }
}

/**
 * Thrown by `response.abort()`, `abortIf()` and `abortUnless()`, built through
 * `invoke()`, so its `code` is `E_HTTP_EXCEPTION`. It handles itself: the
 * response gets its status and its body as given.
 */
export class E_HTTP_REQUEST_ABORTED extends E_HTTP_EXCEPTION {
  handle(error: E_HTTP_EXCEPTION, ctx: HttpContext): void {
    ctx.response.status(error.status).send(error.body)
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
  /** Per-field failures, on a validation error (rune's shape). */
  messages?: unknown
  /** Extra detail an exception chose to carry. */
  errors?: unknown
  /** Set when the thrown value handles its own response. */
  handle?: (error: unknown, ctx: HttpContext) => Promise<void> | void
  /** Set when the thrown value reports itself. */
  report?: (error: unknown, ctx: HttpContext) => Promise<void> | void
  /** A hint appended to the message, when the exception carries one. */
  help?: string
  /**
   * Set by a thrown value that is not an {@link Exception} but whose message is
   * written for clients (the `http-errors` convention). Shown outside debug
   * mode even on a 5xx.
   */
  expose?: boolean
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
  protected renderStatusPages: boolean = currentNodeEnv() === 'production'
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
      // `entries` rather than `keys` plus a lookup: the value comes back
      // already known to be there, instead of read again as maybe-missing.
      for (const [range, renderer] of Object.entries(this.statusPages)) {
        Object.assign(expanded, parseStatusRange(range, renderer))
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
   * client error (status below 500, which a package raises on purpose: 401,
   * 403, 413…), or of an error flagged `expose: true`; anything else
   * collapses to a generic line. AdonisJS echoes `error.message` whatever was
   * thrown, which leaks the text of driver and library errors to the client.
   *
   * Being an `Exception` grants nothing: every package of the ecosystem
   * raises flare `Exception`s, status 500 by default, and their messages name
   * hosts, paths and queries. An application that wants a 5xx message shown
   * sets `expose = true` on its error.
   *
   * A `code` is NOT a reason to show the message: Node system errors
   * (`ECONNREFUSED`, `ENOENT`) and database drivers (`23505`) carry one, and
   * their messages hold internal hosts, file paths, constraint names and
   * stored values. The error itself is left untouched for reporting.
   */
  protected publicMessage(error: HttpError, ctx: HttpContext): string {
    if (this.isDebuggingEnabled(ctx)) return error.message
    if (error.status < 500 || error.expose === true) {
      return error.message
    }
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
   * `html` is listed first, as AdonisJS does, so a request that states no
   * preference — no `Accept` at all, or `*` /`*` — gets the error page rather
   * than a JSON body. A browser always sends `text/html` and an API client
   * always asks for JSON, so the order only decides for the clients in
   * between: curl, a health probe, a proxy that stripped the header. For a
   * framework that ships a view layer, a page is the better answer there.
   *
   * The fallback stays JSON, for a client that accepts none of the three.
   */
  async renderError(error: HttpError, ctx: HttpContext): Promise<void> {
    switch (ctx.request.accepts(['html', 'json', 'application/vnd.api+json'])) {
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
    switch (ctx.request.accepts(['html', 'json', 'application/vnd.api+json'])) {
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
    // rune's errors land here.
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
 * The fields a validation message carries (rune's `RuneErrorNode`).
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

/** Extract status + code from an `Exception` or a duck-typed error. */
function extractErrorMeta(error: unknown): { status: number; code: string } {
  let status = 500
  let code = 'E_UNKNOWN'
  if (error !== null && typeof error === 'object') {
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

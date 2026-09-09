/**
 * Per-request validation.
 *
 * A validator compiled when its module loaded knows nothing about the request
 * about to run through it — yet the two things it most often needs are per
 * request: which language to answer in, and where the errors go. The two
 * static hooks below are that seam. An i18n package installs one at boot:
 *
 * ```ts
 * RequestValidator.messagesProvider = (ctx) => ctx.i18n.createMessagesProvider()
 * ```
 *
 * and every `request.validateUsing(...)` call picks it up, without a single
 * schema mentioning translation. Nothing else in the framework reads them, so
 * a validator called directly keeps whatever provider it was built with.
 *
 * Structural on purpose: ream never imports a validation package. Anything
 * with a `validate(data, options)` fits, which is also what makes this
 * testable without one.
 */

import type { HttpContext } from './HttpContext.ts'

/** What a validator has to expose to be usable here. */
export interface RequestAwareValidator<T> {
  validate(data: Record<string, unknown>, options?: RequestValidationOptions): Promise<T>
}

/** Options forwarded to the validator, plus the data override. */
export interface RequestValidationOptions {
  /** Validate this instead of the request's own data. */
  data?: Record<string, unknown>
  /** Per-call messages provider — beats the static hook. */
  messagesProvider?: unknown
  /** Per-call error reporter factory — beats the static hook. */
  errorReporter?: unknown
  /** Arbitrary metadata a rule can read off the field context. */
  meta?: Record<string, unknown>
}

/**
 * The slice this class reads. A real {@link HttpContext} satisfies it, and so
 * does a bare `{ request }` pair — which is what a Request built by hand, with
 * no context around it, can still offer.
 */
export interface ValidatableContext {
  request: {
    all(): Record<string, unknown>
    params(): Readonly<Record<string, string | string[]>>
    headers(): Readonly<Record<string, unknown>>
    cookiesList(): Record<string, unknown>
  }
}

/**
 * What a hook is handed. The full context when there is one — an i18n package
 * reads `ctx.i18n` off it — and the narrow shape otherwise, which is why this
 * is a union rather than just `HttpContext`.
 */
export type ValidationHookContext = HttpContext | ValidatableContext

export class RequestValidator {
  readonly #ctx: ValidatableContext

  constructor(ctx: ValidatableContext) {
    this.#ctx = ctx
  }

  /**
   * Picks the error reporter for a request. Assigned once, at boot, by
   * whatever package owns error formatting.
   */
  static errorReporter?: (ctx: ValidationHookContext) => unknown

  /**
   * Picks the messages provider for a request. Assigned once, at boot, by
   * whatever package owns translations.
   */
  static messagesProvider?: (ctx: ValidationHookContext) => unknown

  /**
   * Everything a rule might address, in one object.
   *
   * `params`, `headers` and `cookies` are nested under their own keys rather
   * than merged: a form field named `params` is ordinary, and flattening them
   * would let a request rename its own route parameters.
   */
  #requestData(): Record<string, unknown> {
    const { request } = this.#ctx
    return {
      ...request.all(),
      params: request.params(),
      headers: request.headers(),
      cookies: request.cookiesList(),
    }
  }

  /**
   * Fill in the request-scoped reporter and provider, without overwriting
   * anything the caller passed — an explicit option is a deliberate choice
   * for this one call and must outrank a process-wide default.
   */
  #processOptions(options?: RequestValidationOptions): RequestValidationOptions {
    const resolved: RequestValidationOptions = { ...options }
    if (RequestValidator.errorReporter && resolved.errorReporter === undefined) {
      const reporter = RequestValidator.errorReporter(this.#ctx)
      // The validator expects a FACTORY, so a fresh reporter is built per run
      // rather than one instance accumulating across requests.
      resolved.errorReporter = () => reporter
    }
    if (RequestValidator.messagesProvider && resolved.messagesProvider === undefined) {
      resolved.messagesProvider = RequestValidator.messagesProvider(this.#ctx)
    }
    return resolved
  }

  /** Validate the request, throwing `E_VALIDATION_ERROR` on failure. */
  validateUsing<T>(
    validator: RequestAwareValidator<T>,
    options?: RequestValidationOptions,
  ): Promise<T> {
    const resolved = this.#processOptions(options)
    return validator.validate(resolved.data ?? this.#requestData(), resolved)
  }

  /**
   * Validate the request, returning `[error, null]` or `[null, data]`.
   *
   * The tuple form exists so a handler can answer a failure itself instead of
   * letting the exception reach the error handler — a wizard step that
   * re-renders the form, say.
   */
  async tryValidateUsing<T>(
    validator: RequestAwareValidator<T>,
    options?: RequestValidationOptions,
  ): Promise<[unknown, null] | [null, T]> {
    try {
      return [null, await this.validateUsing(validator, options)]
    } catch (error) {
      return [error, null]
    }
  }
}

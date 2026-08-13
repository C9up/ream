/**
 * Unified Middleware Pipeline — typed for HttpContext.
 *
 * @implements FR22, FR27
 *
 * Pipeline order (fixed):
 * 1. Global middleware
 * 2. Route/handler named middleware
 * 3. Route inline middleware
 * 4. Guard (auth + roles + permissions)
 * 5. Handler
 */

import { ReamError } from '../errors/ReamError.js'
import { E_FORBIDDEN, E_UNAUTHORIZED, E_VALIDATION_ERROR } from '../http/Exception.js'
import type { HttpContext } from '../http/HttpContext.js'

export type MiddlewareFunction = (
  ctx: HttpContext,
  next: () => Promise<void>,
) => Promise<void> | void

/** What a route validator must hand back, whichever method it exposes. */
export interface RuntimeValidationResult {
  valid: boolean
  errors: unknown[]
  data?: unknown
}

/**
 * Structural contract for a route validator. ream stays decoupled from the
 * validation engine — any object exposing a result-returning check works.
 *
 * Three spellings are accepted because `@c9up/rune` follows VineJS: `validate()`
 * is async and throws, `validateResult()` is synchronous and never throws, and
 * `validateResultAsync()` is the async result-based form.
 *
 * `validateResultAsync` is preferred. The synchronous `validateResult()` cannot
 * run async rules — with `unique`, `exists` or `useAsync` in the schema it
 * throws a plain Error, which would surface as a 500 instead of a 422.
 */
export interface RuntimeValidator {
  validate?(data: unknown): RuntimeValidationResult | Promise<unknown>
  validateResult?(data: unknown): RuntimeValidationResult
  validateResultAsync?(data: unknown): Promise<RuntimeValidationResult>
}

/** A thrown validation failure, as raised by rune/VineJS `validate()`. */
interface ThrownValidationFailure {
  messages: unknown[]
}

function isThrownValidationFailure(value: unknown): value is ThrownValidationFailure {
  return (
    value instanceof Error && 'messages' in value && Array.isArray(Reflect.get(value, 'messages'))
  )
}

function isValidationResult(value: unknown): value is RuntimeValidationResult {
  return typeof value === 'object' && value !== null && 'valid' in value
}

/**
 * Run a validator whatever contract it exposes, and always come back with a
 * result object.
 *
 * Order matters: the async result form first (it is the only one that can run
 * `unique` / `exists`), then the synchronous one, then VineJS's throwing
 * `validate()` — awaited, and with its `E_VALIDATION_ERROR` translated back
 * into a result so callers keep a single shape to handle.
 */
export async function runValidator(
  validator: RuntimeValidator,
  data: unknown,
): Promise<RuntimeValidationResult> {
  if (typeof validator.validateResultAsync === 'function') {
    return validator.validateResultAsync(data)
  }

  if (typeof validator.validateResult === 'function') {
    return validator.validateResult(data)
  }

  if (typeof validator.validate === 'function') {
    try {
      const outcome = await validator.validate(data)
      // A result-returning `validate()` (not the VineJS contract) is honoured
      // as-is; the throwing contract resolves to the validated payload.
      return isValidationResult(outcome) ? outcome : { valid: true, errors: [], data: outcome }
    } catch (err) {
      if (isThrownValidationFailure(err)) {
        return { valid: false, errors: err.messages }
      }
      throw err
    }
  }

  throw new TypeError(
    'Route validator exposes none of validateResultAsync(), validateResult() or validate().',
  )
}

/** Named middleware registry. */
export class MiddlewareRegistry {
  #global: MiddlewareFunction[] = []
  #named: Map<string, MiddlewareFunction> = new Map()

  /** Register a global middleware (runs on every request). */
  use(middleware: MiddlewareFunction): void {
    this.#global.push(middleware)
  }

  /** Register a named middleware. */
  register(name: string, middleware: MiddlewareFunction): void {
    this.#named.set(name, middleware)
  }

  /** Get a named middleware. */
  get(name: string): MiddlewareFunction | undefined {
    return this.#named.get(name)
  }

  /** Get all global middleware. */
  getGlobal(): MiddlewareFunction[] {
    return [...this.#global]
  }

  /** Build the execution chain for a request. */
  buildChain(
    namedMiddleware: string[],
    inlineMiddleware: MiddlewareFunction[],
    handler: MiddlewareFunction,
    options?: {
      guards?: string[]
      roles?: string[]
      permissions?: string[]
      validators?: RuntimeValidator[]
    },
  ): MiddlewareFunction {
    const stack: MiddlewareFunction[] = [
      // 1. Global middleware
      ...this.#global,
      // 2. Named middleware — an unknown name is a hard error, NOT a silent
      // skip: a typo'd `.middleware('auht')` must never run the route
      // unprotected with zero diagnostics.
      ...namedMiddleware.map((name) => {
        const mw = this.#named.get(name)
        if (mw === undefined) {
          throw new Error(
            `[E_MIDDLEWARE_NOT_FOUND] Named middleware '${name}' is not registered. ` +
              `Registered: ${[...this.#named.keys()].join(', ') || '(none)'}`,
          )
        }
        return mw
      }),
      // 3. Inline middleware
      ...inlineMiddleware,
      // 4. Guard enforcement (throws exceptions instead of setting response)
      ...((options?.guards?.length ?? 0) > 0 ||
      (options?.roles?.length ?? 0) > 0 ||
      (options?.permissions?.length ?? 0) > 0
        ? [createGuardMiddleware(options?.guards ?? [], options?.roles, options?.permissions)]
        : []),
      // 4b. Validation — runs AFTER auth (so unauthenticated requests 401 before
      // the body is inspected) and BEFORE the handler.
      ...((options?.validators?.length ?? 0) > 0
        ? [createValidationMiddleware(options?.validators ?? [])]
        : []),
      // 5. Handler
      handler,
    ]

    return compose(stack)
  }
}

/** Compose middleware into a single handler (onion pattern). */
function compose(middleware: MiddlewareFunction[]): MiddlewareFunction {
  return async (ctx: HttpContext, finalNext: () => Promise<void>) => {
    let index = -1

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new ReamError('PIPELINE_DOUBLE_NEXT', 'next() called multiple times', {
          hint: 'A middleware called next() more than once. Each middleware should call next() at most once.',
        })
      }
      index = i

      const fn = i < middleware.length ? middleware[i] : finalNext
      if (!fn) return

      await fn(ctx, () => dispatch(i + 1))
    }

    await dispatch(0)
  }
}

/**
 * Guard enforcement middleware.
 * Throws E_UNAUTHORIZED / E_FORBIDDEN exceptions (caught by ExceptionHandler).
 */
function createGuardMiddleware(
  guards: string[],
  roles?: string[],
  permissions?: string[],
): MiddlewareFunction {
  return async (ctx, next) => {
    const needsAuth =
      guards.length > 0 || (roles && roles.length > 0) || (permissions && permissions.length > 0)
    if (needsAuth && !ctx.auth.isAuthenticated) {
      throw new E_UNAUTHORIZED()
    }

    // Auth providers may expose roles/permissions at the top level OR nested
    // under `user` (e.g. @c9up/warden sets `ctx.auth.user.roles`). Read both so
    // route-level `.role()`/`.permission()` work regardless of the provider's
    // shape — reading only the top level silently denied every authenticated
    // user when warden was wired.
    if (roles && roles.length > 0) {
      const userRoles = ctx.auth.roles ?? ctx.auth.user?.roles ?? []
      const hasAnyRole = roles.some((r) => userRoles.includes(r))
      if (!hasAnyRole) {
        throw new E_FORBIDDEN('Insufficient role', roles)
      }
    }

    if (permissions && permissions.length > 0) {
      const userPerms = ctx.auth.permissions ?? ctx.auth.user?.permissions ?? []
      if (!permissions.every((p) => userPerms.includes(p))) {
        throw new E_FORBIDDEN('Insufficient permissions', permissions)
      }
    }

    await next()
  }
}

/**
 * Validation enforcement middleware. Runs each resolved route validator against
 * the request body; the first failure throws `E_VALIDATION_ERROR` (422). On
 * success the sanitized/coerced payload is stored on `request.validated()`.
 */
function createValidationMiddleware(validators: RuntimeValidator[]): MiddlewareFunction {
  return async (ctx, next) => {
    for (const validator of validators) {
      const result = await runValidator(validator, ctx.request.body())
      if (!result.valid) {
        throw new E_VALIDATION_ERROR(result.errors)
      }
      if (result.data !== undefined) {
        ctx.request.setValidated(result.data)
      }
    }
    await next()
  }
}

export { compose }

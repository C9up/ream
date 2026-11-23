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

import { debugHttp } from '../debug.js'
import {
  E_MIDDLEWARE_NOT_FOUND,
  E_PIPELINE_DOUBLE_NEXT,
  E_VALIDATOR_UNUSABLE,
} from '../errors/codes.js'
import {
  E_AUTHORIZATION_FAILURE,
  E_UNAUTHORIZED_ACCESS,
  E_VALIDATION_ERROR,
} from '../http/Exception.js'
import type { HttpContext } from '../http/HttpContext.js'
import { authenticatedByGuards, holdsPermissions } from '../http/permissions.js'

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
 * Three spellings are accepted because `@c9up/rune` offers all three: `validate()`
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

/** A thrown validation failure, as raised by rune's `validate()`. */
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
 * `unique` / `exists`), then the synchronous one, then the throwing
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
      // A result-returning `validate()` (not the throwing contract) is honoured
      // as-is; the throwing contract resolves to the validated payload.
      return isValidationResult(outcome) ? outcome : { valid: true, errors: [], data: outcome }
    } catch (err) {
      if (isThrownValidationFailure(err)) {
        return { valid: false, errors: err.messages }
      }
      throw err
    }
  }

  // A dedicated code, not a TypeError: callers tell this configuration
  // mistake apart from a TypeError raised by a bug inside a rule.
  throw new E_VALIDATOR_UNUSABLE()
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
      /** Turns an error into a response where it is thrown, see {@link composeMiddleware}. */
      onError?: MiddlewareErrorHandler
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
          throw new E_MIDDLEWARE_NOT_FOUND([
            `Named middleware '${name}' is not registered. ` +
              `Registered: ${[...this.#named.keys()].join(', ') || '(none)'}`,
          ])
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

    return composeMiddleware(stack, options?.onError)
  }
}

/**
 * What turns an error into a response inside the chain: the exception
 * handler, for the HTTP kernel. It must not throw.
 */
export type MiddlewareErrorHandler = (error: unknown, ctx: HttpContext) => Promise<void>

/**
 * Compose middleware into a single handler (onion pattern).
 *
 * NOT `compose` — that name means mixin composition in `helpers`, the way it
 * does in AdonisJS, and the two were one import away from each other on the
 * barrel.
 */
function composeMiddleware(
  middleware: MiddlewareFunction[],
  onError?: MiddlewareErrorHandler,
): MiddlewareFunction {
  return async (ctx: HttpContext, finalNext: () => Promise<void>) => {
    let index = -1

    // With `onError`, every layer runs under it, as upstream's middleware
    // runner does with an error handler: an error becomes a response at the
    // layer that threw, and the `next()` the outer layer awaits resolves. So
    // the code after `await next()` (the session commit, a header) runs for a
    // request that failed too, and an error's `handle()` that flashes reaches
    // the session store.
    const run = onError
      ? (i: number): Promise<void> => dispatch(i).catch((error: unknown) => onError(error, ctx))
      : dispatch

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new E_PIPELINE_DOUBLE_NEXT()
      }
      index = i

      const fn = i < middleware.length ? middleware[i] : finalNext
      if (!fn) return

      if (debugHttp.enabled && i < middleware.length) {
        // `fn.name` is what a named middleware function or a bound class
        // method carries; an inline arrow has none, and its position is the
        // only thing that identifies it.
        debugHttp('middleware %d/%d %s', i + 1, middleware.length, fn.name || '(anonymous)')
      }
      await fn(ctx, () => run(i + 1))
    }

    await run(0)
  }
}

/**
 * Guard enforcement middleware.
 * Throws `E_UNAUTHORIZED_ACCESS` (401) and `E_AUTHORIZATION_FAILURE` (403),
 * the codes @c9up/warden raises for the same refusals.
 */
function createGuardMiddleware(
  guards: string[],
  roles?: string[],
  permissions?: string[],
): MiddlewareFunction {
  return async (ctx, next) => {
    // A guard list names who may vouch for the request: authenticated by
    // another guard is not enough (see authenticatedByGuards). A 401 from the
    // guards themselves propagates, with its redirect or challenge.
    if (guards.length > 0 && !(await authenticatedByGuards(ctx.auth, guards))) {
      throw new E_UNAUTHORIZED_ACCESS()
    }
    const needsAuth = (roles && roles.length > 0) || (permissions && permissions.length > 0)
    if (needsAuth && !ctx.auth.isAuthenticated) {
      throw new E_UNAUTHORIZED_ACCESS()
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
        throw new E_AUTHORIZATION_FAILURE()
      }
    }

    // A token-authenticated request also needs the token to allow each one.
    if (permissions && permissions.length > 0) {
      if (!(await holdsPermissions(ctx.auth, permissions))) {
        throw new E_AUTHORIZATION_FAILURE()
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

export { composeMiddleware }

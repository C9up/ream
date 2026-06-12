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

/**
 * Structural contract for a route validator. A `@c9up/rune` schema matches this
 * shape, so ream stays decoupled from the validation engine — any object with a
 * `validate(data)` returning `{ valid, errors, data? }` works.
 */
export interface RuntimeValidator {
  validate(data: unknown): { valid: boolean; errors: unknown[]; data?: unknown }
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
    if (needsAuth && !ctx.auth.authenticated) {
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
      const result = validator.validate(ctx.request.body())
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

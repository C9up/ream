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

import type { HttpContext } from '../http/HttpContext.js'
import { E_UNAUTHORIZED, E_FORBIDDEN } from '../http/Exception.js'
import { ReamError } from '../errors/ReamError.js'

export type MiddlewareFunction = (
  ctx: HttpContext,
  next: () => Promise<void>,
) => Promise<void> | void

/** Named middleware registry. */
export class MiddlewareRegistry {
  private global: MiddlewareFunction[] = []
  private named: Map<string, MiddlewareFunction> = new Map()

  /** Register a global middleware (runs on every request). */
  use(middleware: MiddlewareFunction): void {
    this.global.push(middleware)
  }

  /** Register a named middleware. */
  register(name: string, middleware: MiddlewareFunction): void {
    this.named.set(name, middleware)
  }

  /** Get a named middleware. */
  get(name: string): MiddlewareFunction | undefined {
    return this.named.get(name)
  }

  /** Get all global middleware. */
  getGlobal(): MiddlewareFunction[] {
    return [...this.global]
  }

  /** Build the execution chain for a request. */
  buildChain(
    namedMiddleware: string[],
    inlineMiddleware: MiddlewareFunction[],
    handler: MiddlewareFunction,
    options?: { guards?: string[]; roles?: string[]; permissions?: string[] },
  ): MiddlewareFunction {
    const stack: MiddlewareFunction[] = [
      // 1. Global middleware
      ...this.global,
      // 2. Named middleware
      ...namedMiddleware
        .map((name) => this.named.get(name))
        .filter((mw): mw is MiddlewareFunction => mw !== undefined),
      // 3. Inline middleware
      ...inlineMiddleware,
      // 4. Guard enforcement (throws exceptions instead of setting response)
      ...((options?.guards?.length ?? 0) > 0 || (options?.roles?.length ?? 0) > 0 || (options?.permissions?.length ?? 0) > 0
        ? [createGuardMiddleware(options?.guards ?? [], options?.roles, options?.permissions)]
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
function createGuardMiddleware(guards: string[], roles?: string[], permissions?: string[]): MiddlewareFunction {
  return async (ctx, next) => {
    const needsAuth = guards.length > 0 || (roles && roles.length > 0) || (permissions && permissions.length > 0)
    if (needsAuth && !ctx.auth.authenticated) {
      throw new E_UNAUTHORIZED()
    }

    if (roles && roles.length > 0) {
      const userRoles = ctx.auth.roles ?? []
      const hasAnyRole = roles.some((r) => userRoles.includes(r))
      if (!hasAnyRole) {
        throw new E_FORBIDDEN('Insufficient role', roles)
      }
    }

    if (permissions && permissions.length > 0) {
      const userPerms = ctx.auth.permissions ?? []
      if (!permissions.every((p) => userPerms.includes(p))) {
        throw new E_FORBIDDEN('Insufficient permissions', permissions)
      }
    }

    await next()
  }
}

export { compose }

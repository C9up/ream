/**
 * Unified Middleware Pipeline — works on HTTP and bus events.
 *
 * @implements FR22, FR27
 *
 * Pipeline order (fixed):
 * 1. Global middleware
 * 2. Route/handler named middleware
 * 3. Guard (auth)
 * 4. Validate
 * 5. Transaction (if declared)
 * 6. Handler
 * 7. After middleware
 */

import type { Context } from '../Context.js'
import { ReamError } from '../errors/ReamError.js'

export type MiddlewareFunction = (
  ctx: Context,
  next: () => Promise<void>,
) => Promise<void> | void

/** Named middleware registry. */
export class MiddlewareRegistry {
  private global: MiddlewareFunction[] = []
  private named: Map<string, MiddlewareFunction> = new Map()

  /** Register a global middleware (runs on every request/event). */
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
    handler: MiddlewareFunction,
    options?: { guards?: string[] },
  ): MiddlewareFunction {
    const stack: MiddlewareFunction[] = [
      // 1. Global middleware
      ...this.global,
      // 2. Named middleware
      ...namedMiddleware
        .map((name) => this.named.get(name))
        .filter((mw): mw is MiddlewareFunction => mw !== undefined),
      // 3. Guard enforcement (if guards are declared on the route)
      ...((options?.guards?.length ?? 0) > 0 ? [createGuardMiddleware(options!.guards!)] : []),
      // 4. Handler (end of chain)
      handler,
    ]

    return compose(stack)
  }
}

/** Compose middleware into a single handler (onion pattern). */
function compose(middleware: MiddlewareFunction[]): MiddlewareFunction {
  return async (ctx: Context, finalNext: () => Promise<void>) => {
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
 * Create a guard enforcement middleware.
 * Rejects unauthenticated requests when guards are declared on a route.
 */
function createGuardMiddleware(guards: string[]): MiddlewareFunction {
  return async (ctx, next) => {
    if (!ctx.auth.authenticated) {
      ctx.response!.status = 401
      ctx.response!.headers['content-type'] = 'application/json'
      ctx.response!.body = JSON.stringify({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          guards,
        },
      })
      return // short-circuit — handler never runs
    }
    await next()
  }
}

export { compose }

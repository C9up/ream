/**
 * Server — manages HTTP server middleware, error handler, and router.
 *
 * Like AdonisJS Server class:
 * - server.use([() => import('#middleware/...')]) — lazy class middleware
 * - server.errorHandler(() => import('#exceptions/handler')) — custom exception handler
 */

import type { ExceptionHandler } from '../http/Exception.js'
import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareFunction } from '../middleware/Pipeline.js'
import type { Router } from '../router/Router.js'

/**
 * A middleware class with a handle method.
 * This is the pattern used by AdonisJS middleware.
 */
export interface MiddlewareClass {
  handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> | void
}

/** Lazy import returning a module with a default export. */
export type LazyImport<T> = () => Promise<{ default: T }>

// biome-ignore lint/suspicious/noExplicitAny: contravariance — same as ControllerAction
export type ErrorHandlerClass = new (...args: any[]) => ExceptionHandler

// biome-ignore lint/suspicious/noExplicitAny: contravariance — middleware class constructors
type MiddlewareClassConstructor = new (...args: any[]) => MiddlewareClass

/** What server.use() and router.use() accept: lazy imports or direct functions. */
export type MiddlewareEntry = LazyImport<MiddlewareClassConstructor> | MiddlewareFunction

export class Server {
  #router: Router
  #serverMiddleware: MiddlewareFunction[] = []
  #errorHandlerImporter?: LazyImport<ErrorHandlerClass>
  #resolvedErrorHandler?: ExceptionHandler
  #trustedProxies: string[] = []

  constructor(router: Router) {
    this.#router = router
  }

  /**
   * Configure the trusted-proxy CIDR list. The Rust HyperServer uses it to
   * pre-resolve `request.ip` once per request — JS reads the field, no CIDR
   * matching in TS.
   *
   * Empty list (default, 2026-05+) is **strict fail-closed**: `X-Forwarded-For`
   * and `X-Real-IP` are ignored entirely; only the socket peer is used.
   * Apps deployed behind a reverse proxy must list the proxy's CIDR
   * (`'10.0.0.0/8'`, `'192.0.2.0/24'`, etc.) or pass the `'*'` sentinel
   * for permissive mode (accepts spoofing as the explicit trade-off when
   * proxy CIDRs can't be enumerated).
   */
  trustedProxies(cidrs: string[]): this {
    this.#trustedProxies = [...cidrs]
    return this
  }

  /** Read the current trusted-proxy list (consumed by Ignitor at boot). */
  getTrustedProxies(): readonly string[] {
    return this.#trustedProxies
  }

  /**
   * Register global server middleware.
   * Accepts lazy imports of middleware classes (AdonisJS pattern):
   *   server.use([() => import('#middleware/log_request_middleware')])
   */
  use(middleware: MiddlewareEntry[]): this {
    for (const mw of middleware) {
      this.#serverMiddleware.push(resolveMiddlewareEntry(mw))
    }
    return this
  }

  /**
   * Register a custom error handler.
   *   server.errorHandler(() => import('#exceptions/handler'))
   */
  errorHandler(handler: LazyImport<ErrorHandlerClass>): this {
    this.#errorHandlerImporter = handler
    return this
  }

  /** Boot — resolve the error handler. Called by Ignitor during ready phase. */
  async boot(): Promise<void> {
    if (this.#errorHandlerImporter) {
      const mod = await this.#errorHandlerImporter()
      const HandlerClass = mod.default
      this.#resolvedErrorHandler = new HandlerClass()
    }
  }

  getServerMiddleware(): MiddlewareFunction[] {
    return [...this.#serverMiddleware]
  }

  getErrorHandler(): ExceptionHandler | undefined {
    return this.#resolvedErrorHandler
  }

  getRouter(): Router {
    return this.#router
  }
}

/**
 * Convert a MiddlewareEntry (lazy import or function) into a MiddlewareFunction.
 * Lazy imports are resolved on first call and cached.
 */
export function resolveMiddlewareEntry(entry: MiddlewareEntry): MiddlewareFunction {
  // Direct middleware function (2 params: ctx, next)
  if (isMiddlewareFunction(entry)) {
    return entry
  }

  // Lazy import of a middleware class — resolve + cache on first invocation
  // After isMiddlewareFunction returns false, entry is narrowed to LazyImport<MiddlewareClassConstructor>
  const lazyImport = entry
  let cached: MiddlewareClass | undefined
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    if (!cached) {
      const mod = await lazyImport()
      cached = new mod.default()
    }
    await cached.handle(ctx, next)
  }
}

/** Check if an entry is a direct middleware function (not a lazy import). */
function isMiddlewareFunction(entry: MiddlewareEntry): entry is MiddlewareFunction {
  // A lazy import factory returns a promise (dynamic import). Middleware functions don't.
  // We check: if calling it with no args returns a thenable, it's a lazy import.
  // Better heuristic: lazy imports are () => import(...) which have .length === 0
  // and middleware functions have .length >= 2 (ctx, next).
  // Edge case: arrow with defaults has length 1. But lazy import() always has length 0.
  if (typeof entry !== 'function') return false
  // Functions with 2+ params are definitely middleware
  if (entry.length >= 2) return true
  // Functions with 0 params are likely lazy imports
  if (entry.length === 0) return false
  // 1 param is ambiguous — treat as middleware (ctx only, no next)
  return true
}

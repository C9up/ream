/**
 * Server — manages HTTP server middleware, error handler, and router.
 *
 * Like AdonisJS Server class:
 * - server.use([() => import('#middleware/...')]) — lazy class middleware
 * - server.errorHandler(() => import('#exceptions/handler')) — custom exception handler
 */

import type { HttpContext } from '../http/HttpContext.js'
import type { ExceptionHandler } from '../http/Exception.js'
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
  private router: Router
  private _serverMiddleware: MiddlewareFunction[] = []
  private _errorHandlerImporter?: LazyImport<ErrorHandlerClass>
  private _resolvedErrorHandler?: ExceptionHandler

  constructor(router: Router) {
    this.router = router
  }

  /**
   * Register global server middleware.
   * Accepts lazy imports of middleware classes (AdonisJS pattern):
   *   server.use([() => import('#middleware/log_request_middleware')])
   */
  use(middleware: MiddlewareEntry[]): this {
    for (const mw of middleware) {
      this._serverMiddleware.push(resolveMiddlewareEntry(mw))
    }
    return this
  }

  /**
   * Register a custom error handler.
   *   server.errorHandler(() => import('#exceptions/handler'))
   */
  errorHandler(handler: LazyImport<ErrorHandlerClass>): this {
    this._errorHandlerImporter = handler
    return this
  }

  /** Boot — resolve the error handler. Called by Ignitor during ready phase. */
  async boot(): Promise<void> {
    if (this._errorHandlerImporter) {
      const mod = await this._errorHandlerImporter()
      const HandlerClass = mod.default
      this._resolvedErrorHandler = new HandlerClass()
    }
  }

  getServerMiddleware(): MiddlewareFunction[] {
    return [...this._serverMiddleware]
  }

  getErrorHandler(): ExceptionHandler | undefined {
    return this._resolvedErrorHandler
  }

  getRouter(): Router {
    return this.router
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
  const lazyImport = entry as LazyImport<MiddlewareClassConstructor>
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
  // Middleware functions have 2 params (ctx, next). Lazy imports have 0 params.
  return typeof entry === 'function' && entry.length >= 1
}

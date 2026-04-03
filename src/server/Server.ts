/**
 * Server — manages HTTP server middleware, error handler, and router.
 *
 * Like AdonisJS Server class:
 * - server.use([...]) — global server middleware (runs on ALL requests)
 * - server.errorHandler(() => import(...)) — custom exception handler
 * - getRouter() — access the router instance
 *
 * The Server is instantiated by the Ignitor and exposed via services/server.ts
 */

import type { HttpContext } from '../http/HttpContext.js'
import type { ExceptionHandler } from '../http/Exception.js'
import type { MiddlewareFunction } from '../middleware/Pipeline.js'
import type { Router } from '../router/Router.js'

export type LazyImport<T> = () => Promise<{ default: T }>
// biome-ignore lint/suspicious/noExplicitAny: contravariance — same as ControllerAction / AdonisJS Constructor
export type ErrorHandlerClass = new (...args: any[]) => ExceptionHandler

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
   * These run on ALL HTTP requests, even if no route matches.
   * Accepts lazy imports like AdonisJS: server.use([() => import(...)])
   */
  use(middleware: Array<MiddlewareFunction | LazyImport<{ handle: MiddlewareFunction }>>): this {
    for (const mw of middleware) {
      if (typeof mw === 'function' && mw.length <= 2) {
        // Direct middleware function
        this._serverMiddleware.push(mw as MiddlewareFunction)
      } else {
        // Lazy import — resolve at boot time (stored for later)
        const lazyMw = mw as LazyImport<{ handle: MiddlewareFunction }>
        this._serverMiddleware.push(async (ctx: HttpContext, next: () => Promise<void>) => {
          const mod = await lazyMw()
          const instance = new (mod.default as unknown as new () => { handle: (ctx: HttpContext, next: () => Promise<void>) => Promise<void> | void })()
          await instance.handle(ctx, next)
        })
      }
    }
    return this
  }

  /**
   * Register a custom error handler.
   * Like AdonisJS: server.errorHandler(() => import('#exceptions/handler'))
   */
  errorHandler(handler: LazyImport<ErrorHandlerClass>): this {
    this._errorHandlerImporter = handler
    return this
  }

  /**
   * Boot the server — resolve lazy imports and error handler.
   * Called by Ignitor during the ready phase.
   */
  async boot(): Promise<void> {
    if (this._errorHandlerImporter) {
      const mod = await this._errorHandlerImporter()
      const HandlerClass = mod.default
      this._resolvedErrorHandler = new HandlerClass()
    }
  }

  /** Get the registered server-level middleware. */
  getServerMiddleware(): MiddlewareFunction[] {
    return [...this._serverMiddleware]
  }

  /** Get the resolved error handler (or undefined for default). */
  getErrorHandler(): ExceptionHandler | undefined {
    return this._resolvedErrorHandler
  }

  /** Get the Router instance. */
  getRouter(): Router {
    return this.router
  }
}

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
 * A middleware class with a handle method. The optional third argument carries
 * per-route configuration passed through a named-middleware factory (AdonisJS
 * `handle(ctx, next, args)`).
 */
export interface MiddlewareClass {
  handle(ctx: HttpContext, next: () => Promise<void>, args?: unknown): Promise<void> | void
}

/** Lazy import returning a module with a default export. */
export type LazyImport<T> = () => Promise<{ default: T }>

// `never[]` accepts every constructor shape: parameters are contravariant, so a
// rest of `never` is assignable from any concrete list. No `any` needed.
export type ErrorHandlerClass = new (...args: never[]) => ExceptionHandler

export type MiddlewareClassConstructor = new (...args: never[]) => MiddlewareClass

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
 * The imported class is cached on first call; the INSTANCE is resolved through
 * the request's IoC container so `@inject()` constructor dependencies are wired
 * (AdonisJS resolves middleware via the container — a plain `new Class()` gives
 * every injected dependency `undefined`). Falls back to `new Class()` only when
 * no container is present (mock contexts in unit tests).
 */
export function resolveMiddlewareEntry(entry: MiddlewareEntry): MiddlewareFunction {
  // Direct middleware function (2 params: ctx, next)
  if (isMiddlewareFunction(entry)) {
    return entry
  }

  // Lazy import of a middleware class — cache the CLASS on first invocation,
  // then resolve the instance per request through the container (DI). The
  // container's own singleton bindings still cache instances where desired.
  const lazyImport = entry
  let cachedClass: MiddlewareClassConstructor | undefined
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    if (!cachedClass) {
      const mod = await lazyImport()
      if (mod === null || typeof mod !== 'object' || !('default' in mod)) {
        // The zero-arity ambiguity, reported where it can be acted on: a bound
        // or rest-args middleware lands here because it declares no parameters
        // and was read as an import factory.
        throw new Error(
          '[E_MIDDLEWARE_ENTRY] A middleware entry with no declared parameters was treated as a lazy import, ' +
            'but it did not resolve to a module with a default export. ' +
            'If this is an inline middleware (e.g. `handle.bind(this)` or `(...args) => …`), register it on the ' +
            'route or group — `router.get(...).use(fn)` — rather than in `router.use([...])`, which takes ' +
            'imports of middleware classes, as AdonisJS does.',
        )
      }
      cachedClass = mod.default
    }
    const instance = ctx.containerResolver
      ? await ctx.containerResolver.make<MiddlewareClass>(cachedClass)
      : new cachedClass()
    await instance.handle(ctx, next)
  }
}

/**
 * Turn a middleware entry into a FACTORY `(args?) => MiddlewareFunction`
 * (AdonisJS named-middleware factories). The returned function bakes `args` in
 * and forwards them to the class's `handle(ctx, next, args)`. A plain function
 * middleware ignores `args` (it has no third parameter). Class resolution +
 * caching mirror {@link resolveMiddlewareEntry} (imported once, instance via DI).
 */
export function resolveParametrizedMiddlewareEntry(
  entry: MiddlewareEntry,
): (args?: unknown) => MiddlewareFunction {
  if (isMiddlewareFunction(entry)) {
    return () => entry
  }

  const lazyImport = entry
  let cachedClass: MiddlewareClassConstructor | undefined
  return (args?: unknown): MiddlewareFunction => {
    return async (ctx: HttpContext, next: () => Promise<void>) => {
      if (!cachedClass) {
        const mod = await lazyImport()
        cachedClass = mod.default
      }
      const instance = ctx.containerResolver
        ? await ctx.containerResolver.make<MiddlewareClass>(cachedClass)
        : new cachedClass()
      await instance.handle(ctx, next, args)
    }
  }
}

/**
 * Whether an entry is a middleware to run, rather than a module to import.
 *
 * The two are separated by WHERE they are registered, exactly as in AdonisJS:
 * `router.use([...])` takes imports of middleware classes (its own `use()`
 * runs `moduleImporter(one, 'handle')` over every entry), while an inline
 * function goes on a route or group. So this only has to cope with the entries
 * that reach it, and a zero-arity function is an import factory.
 *
 * A middleware that lost its parameters — `handle.bind(this)`, `(...args) =>`
 * — still lands here looking like a factory, which is why the resolver below
 * raises a named error instead of failing somewhere deeper.
 */
function isMiddlewareFunction(entry: MiddlewareEntry): entry is MiddlewareFunction {
  if (typeof entry !== 'function') return false
  // A declared parameter means a middleware: `(ctx)`, `(ctx, next)`.
  if (entry.length > 0) return true
  // Zero declared parameters: an import factory. `router.use()` only takes
  // those, so this is not a guess about which kind an entry is — a closure
  // that reaches here was registered in the wrong place, and the resolver
  // says so rather than running it as a module.
  return false
}

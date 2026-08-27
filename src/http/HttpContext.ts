/**
 * HttpContext — fully typed HTTP context for handlers, middleware, and controllers.
 *
 * Replaces Context.http() for HTTP transport. Always has request + response (no ! assertions).
 * Compatible with AdonisJS destructuring: { request, response, auth, params }
 *
 * @implements FR21
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ServiceToken } from '../container/types.js'
import type { Emitter } from '../events/Emitter.js'
import type { MatchedParams } from '../router/Router.js'
import type { CookieSigner } from '../security/CookieSigner.js'
import type { SignedUrl } from '../security/SignedUrl.js'
import type { Session } from '../session/Session.js'
import type { Authenticators } from '../types/authenticators.js'
import { Macroable } from '../utils/Macroable.js'
import type { RouteUrlResolver } from './RedirectBuilder.js'
import { RedirectBuilder } from './RedirectBuilder.js'
import type { RawRequest } from './Request.js'
import { Request } from './Request.js'
import { Response } from './Response.js'

export interface AuthState {
  /**
   * Whether the request carries an authenticated user (AdonisJS `auth.isAuthenticated`
   * parity, renamed from `authenticated`). Always present — Ream defaults it to
   * `false`; an auth provider (e.g. `@c9up/warden`'s Authenticator) sets it true.
   */
  isAuthenticated: boolean
  user?: {
    id: string
    email?: string
    roles?: string[]
    permissions?: string[]
    [key: string]: unknown
  }
  roles?: string[]
  permissions?: string[]
  /**
   * Optional AdonisJS `Authenticator` surface — present when an auth provider
   * (Warden) fills the slot with a per-request authenticator, absent for the
   * bare `{ isAuthenticated: false }` default. Methods are OPTIONAL so Ream stays
   * agnostic: a non-Warden host, or the default state, remains a valid AuthState.
   */
  authenticate?(): Promise<void>
  check?(): Promise<boolean>
  authenticateUsing?(guards?: string[], options?: { loginRoute?: string }): Promise<void>
  getUserOrFail?(): AuthState['user']
  /**
   * The guard behind `name` (AdonisJS `auth.use('web')`).
   *
   * Typed through the augmentable `Authenticators` interface in
   * `@c9up/ream/types`: an app whose auth package augments it gets the guard's
   * real type back, while a host that augments nothing still resolves to
   * `unknown` rather than failing to compile. Without this, reaching a guard
   * needed a cast that lies about a contract ream does not own.
   */
  use?: {
    <Name extends keyof Authenticators>(name: Name): Authenticators[Name]
    (name: string): unknown
  }
  readonly authenticationAttempted?: boolean
  readonly authenticatedViaGuard?: string
}

/**
 * Per-request authorization entry point — populated by an authorization
 * middleware (e.g. `@c9up/warden`'s Bouncer initializer). A structural
 * contract only: Ream stays agnostic of any concrete authorization package,
 * exactly as `auth` is a slot that Warden fills. A handler authorizes via
 * `await ctx.bouncer?.authorize('post.edit', post)` (throws on denial, mapped
 * to 403 by the ExceptionHandler) or branches on `ctx.bouncer?.allows(...)`.
 */
export interface Authorizer {
  /** True iff the action is authorized. Never throws on denial. */
  allows(ability: string, ...args: unknown[]): Promise<boolean>
  /** Boolean negation of {@link allows}. Never throws on denial. */
  denies(ability: string, ...args: unknown[]): Promise<boolean>
  /** Resolves on allow; throws an authorization failure (status 403) on deny. */
  authorize(ability: string, ...args: unknown[]): Promise<void>
}

/**
 * Per-request IoC resolver exposed on the context (Adonis idiom:
 * `ctx.containerResolver.make(Service)`). Lets agnostic middleware resolve
 * framework-registered services from the context it is HANDED, instead of
 * importing the host app singleton (`@c9up/ream/services/app`) — which would
 * couple the middleware's package to `@c9up/ream` at runtime.
 *
 * Ream populates it from the application {@link Container}, which already
 * satisfies this shape via `make<T>()`. It is the app container today (Ream has
 * no per-request child resolver / `bindValue` scoping yet, unlike AdonisJS);
 * exposing it under the Adonis name with `.make()` keeps the public contract
 * aligned so a future scoped resolver is a non-breaking swap.
 */
// File-local: the app container's minimal resolver shape. Not exported — the
// public resolver contract is the events `ContainerResolver`; each subsystem
// declares its own structurally-compatible interface to stay decoupled (same
// pattern as warden/blackhole middleware), so nothing cross-imports it.
interface ContainerResolver {
  /** Resolve/construct a service by token (class, string, or symbol). Async (AdonisJS parity). */
  make<T>(token: ServiceToken, runtimeValues?: unknown[]): Promise<T>
  /** Call a method with its dependencies injected (AdonisJS `resolver.call`). */
  call<T, K extends string & keyof T>(
    instance: T,
    method: K,
    runtimeValues?: unknown[],
  ): Promise<unknown>
  /** Bind a value for THIS request only (AdonisJS `resolver.bindValue`). */
  bindValue<T>(token: ServiceToken, value: T): void
  /** Whether the token resolves (AdonisJS `resolver.hasBinding`). */
  hasBinding(token: ServiceToken): boolean
  /** Whether every token resolves (AdonisJS `resolver.hasAllBindings`). */
  hasAllBindings(tokens: ServiceToken[]): boolean
}

/**
 * Per-request logger contract (AdonisJS `ctx.logger`). Structural so Ream stays
 * agnostic of the concrete logger — `@c9up/spectrum` satisfies it. Message-first
 * (matches spectrum's ergonomic shape).
 */
export interface ContextLogger {
  trace(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  fatal(message: string, data?: Record<string, unknown>): void
}

/** A logger that can spawn a request-scoped child (e.g. spectrum's `child()`). */
export interface ChildLoggerSource extends ContextLogger {
  child?(options: { correlationId?: string; module?: string }): ContextLogger
}

/** Console fallback used when no `'logger'` is registered in the container. */
function consoleLogger(correlationId: string): ContextLogger {
  const write = (level: string, message: string, data?: Record<string, unknown>): void => {
    const tail = data ? ` ${JSON.stringify(data)}` : ''
    process.stdout.write(`[${level}] (${correlationId}) ${message}${tail}\n`)
  }
  return {
    trace: (m, d) => write('trace', m, d),
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    fatal: (m, d) => write('fatal', m, d),
  }
}

/**
 * Build a request-scoped logger from the app's base logger, or fall back to
 * console. The base logger is resolved (async) once by HttpKernel and injected
 * via {@link HttpContext.setBaseLogger}; child-scoping here stays synchronous
 * so `ctx.logger` remains a plain getter.
 */
function resolveRequestLogger(
  base: ChildLoggerSource | undefined,
  correlationId: string,
): ContextLogger {
  if (!base) return consoleLogger(correlationId)
  return typeof base.child === 'function' ? base.child({ correlationId }) : base
}

export interface RouteInfo {
  pattern: string
  name?: string
  middleware: string[]
  /**
   * Controller class + method that owns this route, when the route was
   * registered as `router.get('/x', SomeController, 'method')` (vs an
   * inline arrow handler). Middleware that reads decorator metadata —
   * `@Guard`, `@Permission`, `@Role` (Warden), `@Meta` (Photon) —
   * needs both fields. Absent when the route handler is an inline
   * function. Populated by `HttpKernel` from `match.route.controller`.
   */
  controller?: object
  action?: string
}

/**
 * The `'ControllerName.method'` identity of a route, or undefined for an inline
 * handler. This is what `request.matchesRoute()` matches on besides the name and
 * the pattern, the way AdonisJS matches `route.handler.reference`.
 */
function controllerReference(route: RouteInfo): string | undefined {
  const controller = route.controller as { name?: string } | undefined
  if (!controller?.name || !route.action) return undefined
  return `${controller.name}.${route.action}`
}

/** Ambient per-request context store (AdonisJS `HttpContext` ALS accessor). */
const httpContextStorage = new AsyncLocalStorage<HttpContext>()

/**
 * Whether the ambient context is being tracked.
 *
 * NAMED DEVIATION — on by default, where AdonisJS makes it opt-in through
 * `useAsyncLocalStorage` in `config/app.ts`. Ream's own middleware and service
 * accessors read the ambient context, so defaulting it off would break the
 * framework's own wiring rather than just an app's. Turn it off with
 * {@link HttpContext.useAsyncLocalStorage} to reclaim the tracking cost.
 */
let asyncLocalStorageEnabled = true

export class HttpContext extends Macroable {
  /**
   * @internal Run `fn` with `ctx` as the ambient HttpContext, so code deep in
   * the call stack can reach it via {@link HttpContext.get}/{@link getOrFail}
   * without threading `ctx` through every signature. HttpKernel wraps the
   * request pipeline in this.
   */
  static run<T>(ctx: HttpContext, fn: () => T): T {
    if (!asyncLocalStorageEnabled) return fn()
    return httpContextStorage.run(ctx, fn)
  }

  /**
   * Whether the ambient context is being tracked (AdonisJS
   * `HttpContext.usingAsyncLocalStorage`). When false, {@link get} always
   * answers `null` and {@link getOrFail} always throws.
   */
  static get usingAsyncLocalStorage(): boolean {
    return asyncLocalStorageEnabled
  }

  /**
   * Turn ambient-context tracking on or off.
   *
   * AdonisJS decides this from `useAsyncLocalStorage` in `config/app.ts`; ream
   * has it on by default (see the note on the storage above) and exposes the
   * switch instead of a config key, so a benchmark or a worker process can
   * drop the tracking without a config file.
   */
  static useAsyncLocalStorage(enabled: boolean): void {
    asyncLocalStorageEnabled = enabled
  }

  /**
   * The ambient HttpContext, or `null` outside a request (AdonisJS
   * `HttpContext.get()`).
   *
   * `null`, not `undefined`: upstream's contract is `HttpContext | null`, and a
   * migrated `=== null` check has to keep working.
   */
  static get(): HttpContext | null {
    if (!asyncLocalStorageEnabled) return null
    return httpContextStorage.getStore() ?? null
  }

  /** The ambient HttpContext, or throw outside a request (AdonisJS `HttpContext.getOrFail()`). */
  static getOrFail(): HttpContext {
    if (!asyncLocalStorageEnabled) {
      throw new Error(
        '[E_HTTP_CONTEXT_NOT_FOUND] HttpContext.getOrFail() called while ambient-context tracking is off. Re-enable it with HttpContext.useAsyncLocalStorage(true), or pass ctx explicitly.',
      )
    }
    const ctx = httpContextStorage.getStore()
    if (!ctx) {
      throw new Error(
        '[E_HTTP_CONTEXT_NOT_FOUND] HttpContext.getOrFail() called outside an HTTP request — no ambient context. Pass ctx explicitly, or only call this within the request lifecycle.',
      )
    }
    return ctx
  }

  /**
   * Run `fn` with the ambient HttpContext temporarily cleared (AdonisJS
   * `HttpContext.runOutsideContext`) — e.g. to detach background work so it
   * doesn't inherit and pin the request's context.
   */
  static runOutsideContext<T>(fn: () => T): T {
    return httpContextStorage.exit(fn)
  }

  /**
   * A one-line summary of the request (AdonisJS `inspect`).
   *
   * What a log line or a debugger label wants: the verb, the path, and which
   * route answered.
   */
  inspect(): string {
    const route = this.route.name ?? this.route.pattern
    return `${this.request.method()} ${this.request.url()} (${route})`
  }

  /** Unique request/correlation ID. */
  readonly id: string

  /** Typed HTTP request. */
  readonly request: Request

  /** Typed HTTP response builder. */
  readonly response: Response

  /** Route parameters extracted from the URL pattern. */
  /** Matched route parameters — `*` holds the segments it swallowed, as an array. */
  /**
   * Route parameters.
   *
   * `string | string[]`, not AdonisJS's `any`: a catch-all `*` really is the
   * ARRAY of segments on both sides, so the `any` upstream only hides it. Use
   * {@link Request.param} when you want the single-value form — it joins a
   * catch-all with `/` and returns `string | undefined`.
   */
  readonly params: MatchedParams

  /** Information about the matched route. */
  readonly route: RouteInfo

  /** Authentication state — populated by auth middleware. */
  auth: AuthState = { isAuthenticated: false }

  /**
   * Request locale — the primary subtag of the first `Accept-Language` entry
   * (e.g. `fr-CH,fr;q=0.9` → `fr`), defaulting to `en`. Middleware (or i18n)
   * may override it; it's a plain mutable field.
   */
  locale = 'en'

  /** Per-request key-value store (for middleware to pass data downstream). */
  readonly store: Map<string, unknown> = new Map()

  /**
   * The request session, when `SessionMiddleware` is registered (AdonisJS
   * `ctx.session` parity). Top-level so consumers — and Warden's session
   * strategy — read `ctx.session` directly rather than fishing it out of
   * `store`. Undefined when no session middleware ran.
   */
  session?: Session

  /**
   * The event bus emitter, when the app registered `EventsProvider`. Lets a
   * handler emit/subscribe without resolving from the container:
   * `ctx.events?.emit('user:updated', user)`. Undefined when events aren't wired.
   */
  events?: Emitter

  /**
   * Per-request authorization entry point, when an authorization middleware
   * is wired (e.g. `@c9up/warden`'s Bouncer initializer). Undefined when no
   * such middleware ran. See {@link Authorizer}.
   */
  bouncer?: Authorizer

  /**
   * Per-request IoC resolver (Adonis idiom: `ctx.containerResolver.make(...)`).
   * Built by `HttpKernel` with `container.createResolver()`, so a value bound
   * on it belongs to THIS request and no other. Undefined only when the context
   * was built without one (e.g. a mock in a unit test).
   * Agnostic middleware resolves host services through this, never by importing
   * `@c9up/ream`. See {@link ContainerResolver}.
   */
  readonly containerResolver?: ContainerResolver

  /** Lazily-built per-request logger (see {@link logger}). */
  #logger?: ContextLogger

  /** App base logger, resolved once (async) by HttpKernel and injected. */
  #baseLogger?: ChildLoggerSource

  /** Route URL resolver for redirect().toRoute(). */
  #routeUrlResolver?: RouteUrlResolver

  /**
   * Per-request logger (AdonisJS `ctx.logger`) — the injected app logger (e.g.
   * `@c9up/spectrum`) child-scoped to this request's `id`, or a console logger
   * when none is registered. Built once, on first access.
   */
  get logger(): ContextLogger {
    if (!this.#logger) {
      this.#logger = resolveRequestLogger(this.#baseLogger, this.id)
    }
    return this.#logger
  }

  /** @internal Inject the app base logger (resolved async by HttpKernel). */
  setBaseLogger(logger: ChildLoggerSource): void {
    this.#baseLogger = logger
  }

  /** @internal Inject the APP_KEY cookie signer into request + response (from HttpKernel). */
  setCookieSigner(signer: CookieSigner): void {
    this.response.setCookieSigner(signer)
    this.request.setCookieSigner(signer)
  }

  /** @internal Inject the APP_KEY signed-URL helper into the request (from HttpKernel). */
  setSignedUrl(signedUrl: SignedUrl): void {
    this.request.setSignedUrl(signedUrl)
  }

  /** Subdomains of the request host (AdonisJS `ctx.subdomains`). */
  get subdomains(): string[] {
    return this.request.subdomains()
  }

  /** Stable identifier for the matched route (`METHOD-pattern`) — AdonisJS `ctx.routeKey`. */
  get routeKey(): string {
    return `${this.request.method()}-${this.route.pattern}`
  }

  constructor(
    id: string,
    rawRequest: RawRequest,
    params: MatchedParams,
    route: RouteInfo,
    containerResolver?: ContainerResolver,
  ) {
    super()
    this.id = id
    this.params = params
    this.route = route
    this.containerResolver = containerResolver
    this.request = new Request(rawRequest, params)
    this.response = new Response()
    // Give the response read access to the request (AdonisJS wires them too) —
    // needed by `response.fresh()` for conditional-GET / ETag revalidation.
    this.response.setRequest(this.request)
    // And the reverse, so `request.fresh()`/`stale()` delegate to it, plus the
    // matched-route info for `request.matchesRoute()`.
    this.request.setResponse(this.response)
    // The back-references AdonisJS exposes as `request.ctx` / `response.ctx`.
    this.request.ctx = this
    this.response.ctx = this
    this.request.setRouteInfo({
      name: route.name,
      pattern: route.pattern,
      reference: controllerReference(route),
    })
    // APP_KEY-backed encryption / signed-URL services + the base logger are
    // resolved asynchronously by HttpKernel and injected via the setters above
    // (the container is async now, so a constructor can't resolve them itself).
    this.locale = parseAcceptLanguage(this.request.header('accept-language')) ?? 'en'

    // Wire redirect builder with request context
    this.response.setRedirectFactory(
      () =>
        new RedirectBuilder(this.response, {
          requestUrl: this.request.url(),
          requestReferer: this.request.header('referer'),
          routeUrlResolver: this.#routeUrlResolver,
        }),
    )
  }

  /** @internal Set the route URL resolver (injected by HttpKernel from Router). */
  setRouteUrlResolver(resolver: RouteUrlResolver): void {
    this.#routeUrlResolver = resolver
  }
}

/** Primary subtag of the first Accept-Language entry: `fr-CH,fr;q=0.9` → `fr`. */
function parseAcceptLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined
  const first = header.split(',')[0]?.trim().split(';')[0]?.trim()
  const primary = first?.split('-')[0]?.toLowerCase()
  return primary || undefined
}

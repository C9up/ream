/**
 * HttpContext — fully typed HTTP context for handlers, middleware, and controllers.
 *
 * Replaces Context.http() for HTTP transport. Always has request + response (no ! assertions).
 * Compatible with AdonisJS destructuring: { request, response, auth, params }
 *
 * @implements FR21
 */

import type { ServiceToken } from '../container/types.js'
import type { Emitter } from '../events/Emitter.js'
import type { RouteUrlResolver } from './RedirectBuilder.js'
import { RedirectBuilder } from './RedirectBuilder.js'
import type { RawRequest } from './Request.js'
import { Request } from './Request.js'
import { Response } from './Response.js'

export interface AuthState {
  authenticated: boolean
  user?: {
    id: string
    email?: string
    roles?: string[]
    permissions?: string[]
    [key: string]: unknown
  }
  roles?: string[]
  permissions?: string[]
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
export interface ContainerResolver {
  /** Resolve/construct a service by token (class, string, or symbol). */
  make<T>(token: ServiceToken): T
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

export class HttpContext {
  /** Unique request/correlation ID. */
  readonly id: string

  /** Typed HTTP request. */
  readonly request: Request

  /** Typed HTTP response builder. */
  readonly response: Response

  /** Route parameters extracted from the URL pattern. */
  readonly params: Record<string, string>

  /** Information about the matched route. */
  readonly route: RouteInfo

  /** Authentication state — populated by auth middleware. */
  auth: AuthState = { authenticated: false }

  /**
   * Request locale — the primary subtag of the first `Accept-Language` entry
   * (e.g. `fr-CH,fr;q=0.9` → `fr`), defaulting to `en`. Middleware (or i18n)
   * may override it; it's a plain mutable field.
   */
  locale = 'en'

  /** Per-request key-value store (for middleware to pass data downstream). */
  readonly store: Map<string, unknown> = new Map()

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
   * Populated by `HttpKernel` from the application container. Undefined only
   * when the context was built without one (e.g. a mock in a unit test).
   * Agnostic middleware resolves host services through this, never by importing
   * `@c9up/ream`. See {@link ContainerResolver}.
   */
  readonly containerResolver?: ContainerResolver

  /** Route URL resolver for redirect().toRoute(). */
  #routeUrlResolver?: RouteUrlResolver

  constructor(
    id: string,
    rawRequest: RawRequest,
    params: Record<string, string>,
    route: RouteInfo,
    containerResolver?: ContainerResolver,
  ) {
    this.id = id
    this.params = params
    this.route = route
    this.containerResolver = containerResolver
    this.request = new Request(rawRequest, params)
    this.response = new Response()
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

/**
 * HttpContext — fully typed HTTP context for handlers, middleware, and controllers.
 *
 * Replaces Context.http() for HTTP transport. Always has request + response (no ! assertions).
 * Compatible with AdonisJS destructuring: { request, response, auth, params }
 *
 * @implements FR21
 */

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

  /** Detected locale. */
  locale = 'en'

  /** Per-request key-value store (for middleware to pass data downstream). */
  readonly store: Map<string, unknown> = new Map()

  /**
   * The event bus emitter, when the app registered `EventsProvider`. Lets a
   * handler emit/subscribe without resolving from the container:
   * `ctx.events?.emit('user:updated', user)`. Undefined when events aren't wired.
   */
  events?: Emitter

  /** Route URL resolver for redirect().toRoute(). */
  #routeUrlResolver?: RouteUrlResolver

  constructor(
    id: string,
    rawRequest: RawRequest,
    params: Record<string, string>,
    route: RouteInfo,
  ) {
    this.id = id
    this.params = params
    this.route = route
    this.request = new Request(rawRequest, params)
    this.response = new Response()

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

/**
 * HttpContext — fully typed HTTP context for handlers, middleware, and controllers.
 *
 * Replaces Context.http() for HTTP transport. Always has request + response (no ! assertions).
 * Compatible with AdonisJS destructuring: { request, response, auth, params }
 *
 * @implements FR21
 */

import type { RawRequest } from './Request.js'
import { Request } from './Request.js'
import { Response } from './Response.js'
import { RedirectBuilder } from './RedirectBuilder.js'
import type { RouteUrlResolver } from './RedirectBuilder.js'

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

  /** Route URL resolver for redirect().toRoute(). */
  private _routeUrlResolver?: RouteUrlResolver

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
    this.response._setRedirectFactory(() => new RedirectBuilder(this.response, {
      requestUrl: this.request.url(),
      requestReferer: this.request.header('referer'),
      routeUrlResolver: this._routeUrlResolver,
    }))
  }

  /** @internal Set the route URL resolver (injected by HttpKernel from Router). */
  _setRouteUrlResolver(resolver: RouteUrlResolver): void {
    this._routeUrlResolver = resolver
  }
}

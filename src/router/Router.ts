/**
 * Fluent Router — AdonisJS v6 compatible routing with controllers, resources, and groups.
 *
 * @implements FR24, FR25, FR26, FR27, FR28
 */

import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareFunction } from '../middleware/Pipeline.js'
import type { MiddlewareEntry } from '../server/Server.js'
import { resolveMiddlewareEntry } from '../server/Server.js'

// ─── Types ──────────────────────────────────────────────────

export type RouteHandlerFunction = (ctx: HttpContext) => Promise<void> | void

/**
 * Controller tuple: [ControllerClass, 'methodName'].
 * Constructor params are resolved by the IoC container, not by TypeScript —
 * same pattern as AdonisJS (@poppinss/utils Constructor type).
 */
// biome-ignore lint/suspicious/noExplicitAny: required — TypeScript contravariance makes it impossible to type "any constructor" without `any`
export type ControllerAction = [target: new (...args: any[]) => any, method: string]

/** A route handler is either a closure or a controller tuple. */
export type RouteHandler = RouteHandlerFunction | ControllerAction

/** Param matcher — regex or predefined matcher. */
export type ParamMatcher = RegExp | { pattern: RegExp }

export interface RouteDefinition {
  method: string
  path: string
  handler: RouteHandlerFunction | null
  // biome-ignore lint/suspicious/noExplicitAny: see ControllerAction
  controller?: { target: new (...args: any[]) => any; method: string }
  middleware: string[]
  inlineMiddleware: MiddlewareFunction[]
  guards: string[]
  roles: string[]
  permissions: string[]
  validators: string[]
  name?: string
  version?: string
  domain?: string
  matchers: Record<string, ParamMatcher>
  deprecates?: { version: string; sunset?: string }
}

export interface MatchResult {
  route: RouteDefinition
  params: Record<string, string>
}

// ─── Matchers ───────────────────────────────────────────────

export const matchers = {
  /** Match numeric params only. */
  number(): ParamMatcher {
    return { pattern: /^\d+$/ }
  },
  /** Match UUID v4 params only. */
  uuid(): ParamMatcher {
    return { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i }
  },
  /** Match slug params only (lowercase alphanumeric + hyphens). */
  slug(): ParamMatcher {
    return { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }
  },
}

// ─── RouteBuilder ───────────────────────────────────────────

/** Fluent route builder — mutates the already-registered route definition. */
export class RouteBuilder {
  private route: RouteDefinition

  constructor(route: RouteDefinition) {
    this.route = route
  }

  /** Name this route (for URL generation and redirects). */
  as(name: string): this {
    this.route.name = name
    return this
  }

  /** Add named middleware. */
  middleware(...names: string[]): this {
    this.route.middleware.push(...names)
    return this
  }

  /** Add inline middleware functions. */
  use(...mw: MiddlewareFunction[]): this {
    this.route.inlineMiddleware.push(...mw)
    return this
  }

  /** Add authentication guards. */
  guard(...guards: string[]): this {
    this.route.guards.push(...guards)
    return this
  }

  /** Require specific roles. */
  role(...roles: string[]): this {
    this.route.roles.push(...roles)
    return this
  }

  /** Require specific permissions. */
  permission(...permissions: string[]): this {
    this.route.permissions.push(...permissions)
    return this
  }

  /** Add a param constraint. */
  where(param: string, matcher: ParamMatcher | RegExp): this {
    this.route.matchers[param] = matcher instanceof RegExp ? { pattern: matcher } : matcher
    return this
  }

  /** Attach a validator. */
  validate(validator: string): this {
    this.route.validators.push(validator)
    return this
  }

  /** Set API version. */
  version(v: string): this {
    this.route.version = v
    return this
  }

  /** Restrict to a specific domain. */
  domain(d: string): this {
    this.route.domain = d
    return this
  }

  /** Mark as deprecated. */
  deprecates(version: string, options?: { sunset?: string }): this {
    this.route.deprecates = { version, sunset: options?.sunset }
    return this
  }

  /** @internal Get the underlying definition. */
  getDefinition(): RouteDefinition {
    return this.route
  }
}

// ─── GroupBuilder ───────────────────────────────────────────

/** Fluent group builder — returned by router.group(callback). */
export class GroupBuilder {
  private routes: RouteDefinition[]
  private parentRouter: Router

  constructor(routes: RouteDefinition[], parentRouter: Router) {
    this.routes = routes
    this.parentRouter = parentRouter
  }

  /** Set URL prefix for all routes in the group. */
  prefix(p: string): this {
    for (const route of this.routes) {
      route.path = p + route.path
    }
    return this
  }

  /** Add middleware to all routes in the group. */
  middleware(...names: string[]): this {
    for (const route of this.routes) {
      route.middleware = [...names, ...route.middleware]
    }
    return this
  }

  /** Add inline middleware to all routes in the group. */
  use(...mw: MiddlewareFunction[]): this {
    for (const route of this.routes) {
      route.inlineMiddleware = [...mw, ...route.inlineMiddleware]
    }
    return this
  }

  /** Add guards to all routes in the group. */
  guard(...guards: string[]): this {
    for (const route of this.routes) {
      route.guards = [...guards, ...route.guards]
    }
    return this
  }

  /** Prefix route names for all routes in the group. */
  as(namePrefix: string): this {
    for (const route of this.routes) {
      if (route.name) {
        route.name = `${namePrefix}.${route.name}`
      }
    }
    return this
  }

  /** Set domain for all routes in the group. */
  domain(d: string): this {
    for (const route of this.routes) {
      route.domain = d
    }
    return this
  }

  /** Add param matcher to all routes in the group. */
  where(param: string, matcher: ParamMatcher | RegExp): this {
    const m = matcher instanceof RegExp ? { pattern: matcher } : matcher
    for (const route of this.routes) {
      if (!(param in route.matchers)) {
        route.matchers[param] = m
      }
    }
    return this
  }
}

// ─── OnRouteBuilder ─────────────────────────────────────────

/** Builder for on(path).render(view) and on(path).redirect(target). */
export class OnRouteBuilder {
  private router: Router
  private path: string

  constructor(router: Router, path: string) {
    this.router = router
    this.path = path
  }

  /** Render a view (requires Photon/view provider). */
  render(view: string, data?: Record<string, unknown>): RouteBuilder {
    return this.router.get(this.path, async (ctx) => {
      const viewEngine = ctx.store.get('view') as { render(name: string, data?: Record<string, unknown>): Promise<string> } | undefined
      if (!viewEngine) {
        throw new Error('View engine not configured. Register a view provider (Photon) first.')
      }
      const html = await viewEngine.render(view, data)
      ctx.response.type('text/html; charset=utf-8').send(html)
    })
  }

  /** Redirect to a path. */
  redirect(target: string, status = 302): RouteBuilder {
    return this.router.get(this.path, async (ctx) => {
      ctx.response.redirect().status(status).toPath(target)
    })
  }

  /** Redirect to a named route. */
  redirectToRoute(name: string, params?: Record<string, string>, status = 302): RouteBuilder {
    return this.router.get(this.path, async (ctx) => {
      ctx.response.redirect().status(status).toRoute(name, params)
    })
  }
}

// ─── Router ─────────────────────────────────────────────────

/** Main Router. */
export class Router {
  private routes: RouteDefinition[] = []
  private globalMatchers: Record<string, ParamMatcher> = {}
  private _routerMiddleware: MiddlewareFunction[] = []
  private _namedMiddleware: Map<string, MiddlewareFunction> = new Map()

  /** Predefined param matchers. */
  readonly matchers = matchers

  // ─── Router-level middleware (like AdonisJS) ──────────────

  /**
   * Register router-level middleware (runs on requests with a matched route).
   *   router.use([() => import('#middleware/auth_middleware')])
   */
  use(middleware: MiddlewareEntry[]): this {
    for (const mw of middleware) {
      this._routerMiddleware.push(resolveMiddlewareEntry(mw))
    }
    return this
  }

  /**
   * Register named middleware collection.
   *   export const middleware = router.named({
   *     auth: () => import('#middleware/auth_middleware'),
   *   })
   */
  named(collection: Record<string, MiddlewareEntry>): Record<string, MiddlewareFunction> {
    const resolved: Record<string, MiddlewareFunction> = {}
    for (const [name, mw] of Object.entries(collection)) {
      const fn = resolveMiddlewareEntry(mw)
      this._namedMiddleware.set(name, fn)
      resolved[name] = fn
    }
    return resolved
  }

  /** Get the router-level middleware stack. */
  getRouterMiddleware(): MiddlewareFunction[] {
    return [...this._routerMiddleware]
  }

  /** Get a named middleware by name. */
  getNamedMiddleware(name: string): MiddlewareFunction | undefined {
    return this._namedMiddleware.get(name)
  }

  // ─── Route registration ───────────────────────────────────

  /** Register a route with any HTTP method. */
  route(method: string, path: string, handler: RouteHandler): RouteBuilder {
    const def = this.createDefinition(method, path, handler)
    this.routes.push(def)
    return new RouteBuilder(def)
  }

  get(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('POST', path, handler)
  }

  put(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('PUT', path, handler)
  }

  patch(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('PATCH', path, handler)
  }

  delete(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('DELETE', path, handler)
  }

  head(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('HEAD', path, handler)
  }

  options(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('OPTIONS', path, handler)
  }

  /** Register a route for all HTTP methods. */
  any(path: string, handler: RouteHandler): RouteBuilder {
    return this.route('*', path, handler)
  }

  // ─── Resource routes ──────────────────────────────────────

  /**
   * Register resourceful routes for a controller.
   * Generates: index, store, show, update, destroy
   *
   * Usage:
   *   router.resource('posts', PostsController)
   *   // GET    /posts          → PostsController.index
   *   // POST   /posts          → PostsController.store
   *   // GET    /posts/:id      → PostsController.show
   *   // PUT    /posts/:id      → PostsController.update
   *   // DELETE /posts/:id      → PostsController.destroy
   */
  // biome-ignore lint/suspicious/noExplicitAny: see ControllerAction
  resource(path: string, controller: new (...args: any[]) => any): GroupBuilder {
    const baseName = path.replace(/\//g, '.')
    const routes: RouteDefinition[] = []

    const actions: Array<{ method: string; suffix: string; action: string; nameSuffix: string }> = [
      { method: 'GET', suffix: '', action: 'index', nameSuffix: 'index' },
      { method: 'POST', suffix: '', action: 'store', nameSuffix: 'store' },
      { method: 'GET', suffix: '/:id', action: 'show', nameSuffix: 'show' },
      { method: 'PUT', suffix: '/:id', action: 'update', nameSuffix: 'update' },
      { method: 'PATCH', suffix: '/:id', action: 'update', nameSuffix: 'update' },
      { method: 'DELETE', suffix: '/:id', action: 'destroy', nameSuffix: 'destroy' },
    ]

    for (const { method, suffix, action, nameSuffix } of actions) {
      const def = this.createDefinition(method, `/${path}${suffix}`, [controller, action])
      def.name = `${baseName}.${nameSuffix}`
      routes.push(def)
      this.routes.push(def)
    }

    return new GroupBuilder(routes, this)
  }

  // ─── Groups ───────────────────────────────────────────────

  /**
   * Create a route group with shared configuration.
   *
   * AdonisJS-style (chainable):
   *   router.group(() => {
   *     router.get('/users', [UsersController, 'index'])
   *   }).prefix('/api').middleware('auth')
   *
   * Legacy-style (config object):
   *   router.group({ prefix: '/api', guards: ['jwt'] }, (r) => {
   *     r.get('/users', handler)
   *   })
   */
  group(callback: () => void): GroupBuilder
  group(config: { prefix?: string; middleware?: string[]; guards?: string[]; roles?: string[]; permissions?: string[] }, callback: (router: Router) => void): void
  group(
    callbackOrConfig: (() => void) | { prefix?: string; middleware?: string[]; guards?: string[]; roles?: string[]; permissions?: string[] },
    legacyCallback?: (router: Router) => void,
  ): GroupBuilder | void {
    if (typeof callbackOrConfig === 'function') {
      // AdonisJS-style: group(() => { ... }).prefix().middleware()
      const snapshot = this.routes.length
      callbackOrConfig()
      const newRoutes = this.routes.slice(snapshot)
      return new GroupBuilder(newRoutes, this)
    }

    // Legacy-style: group({ prefix, guards }, (r) => { ... })
    const config = callbackOrConfig
    const childRouter = new Router()
    legacyCallback!(childRouter)

    for (const route of childRouter.routes) {
      this.routes.push({
        ...route,
        path: (config.prefix ?? '') + route.path,
        middleware: [...(config.middleware ?? []), ...route.middleware],
        guards: [...(config.guards ?? []), ...route.guards],
        roles: [...(config.roles ?? []), ...route.roles],
        permissions: [...(config.permissions ?? []), ...route.permissions],
      })
    }
  }

  // ─── On (view/redirect shortcuts) ─────────────────────────

  /** Create a view/redirect route shortcut. */
  on(path: string): OnRouteBuilder {
    return new OnRouteBuilder(this, path)
  }

  // ─── Global matchers ──────────────────────────────────────

  /** Set a global param matcher (applied to all routes). */
  where(param: string, matcher: ParamMatcher | RegExp): this {
    this.globalMatchers[param] = matcher instanceof RegExp ? { pattern: matcher } : matcher
    return this
  }

  // ─── Route matching ───────────────────────────────────────

  /** Find a matching route, extracting :param values and validating matchers. */
  match(method: string, path: string, host?: string): MatchResult | undefined {
    for (const route of this.routes) {
      if (route.method !== '*' && route.method !== method) continue

      // Domain check — if route has a domain constraint, host must match
      if (route.domain && host && !matchDomain(route.domain, host)) continue

      const params = matchPath(route.path, path)
      if (params === null) continue

      // Validate param matchers (route-level + global)
      if (!this.validateMatchers(params, route.matchers)) continue
      if (!this.validateMatchers(params, this.globalMatchers)) continue

      return { route, params }
    }
    return undefined
  }

  // ─── URL generation ───────────────────────────────────────

  /** Generate a URL from a named route. */
  makeUrl(name: string, params?: Record<string, string>): string {
    const route = this.routes.find((r) => r.name === name)
    if (!route) {
      throw new Error(`Route '${name}' not found. Available: ${this.routes.filter(r => r.name).map(r => r.name).join(', ')}`)
    }
    let url = route.path
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url = url.replace(`:${key}`, encodeURIComponent(value))
      }
    }
    return url
  }

  // ─── Accessors ────────────────────────────────────────────

  getRoutes(): RouteDefinition[] {
    return [...this.routes]
  }

  /** Clear all registered routes (used by hot-reload). */
  clear(): void {
    this.routes = []
  }

  get routeCount(): number {
    return this.routes.length
  }

  // ─── Internals ────────────────────────────────────────────

  private createDefinition(method: string, path: string, handler: RouteHandler): RouteDefinition {
    const def: RouteDefinition = {
      method: method.toUpperCase(),
      path,
      handler: null,
      middleware: [],
      inlineMiddleware: [],
      guards: [],
      roles: [],
      permissions: [],
      validators: [],
      matchers: {},
    }

    if (Array.isArray(handler)) {
      def.controller = { target: handler[0], method: handler[1] }
    } else {
      def.handler = handler
    }

    return def
  }

  private validateMatchers(params: Record<string, string>, matcherMap: Record<string, ParamMatcher>): boolean {
    for (const [param, value] of Object.entries(params)) {
      const matcher = matcherMap[param]
      if (!matcher) continue
      const regex = matcher instanceof RegExp ? matcher : matcher.pattern
      if (!regex.test(value)) return false
    }
    return true
  }
}

// ─── Path matching ──────────────────────────────────────────

/** Match path pattern against actual path, extracting params. Returns null on no match. */
function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const actualParts = actual.split('/')

  if (patternParts.length !== actualParts.length) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]
    if (part.startsWith(':')) {
      const paramName = part.endsWith('?') ? part.slice(1, -1) : part.substring(1)
      params[paramName] = actualParts[i]
    } else if (part !== actualParts[i]) {
      return null
    }
  }

  return params
}

/** Match domain pattern against actual host. Supports wildcards like *.example.com */
function matchDomain(pattern: string, host: string): boolean {
  const actualHost = host.split(':')[0] // strip port
  if (pattern === actualHost) return true
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // ".example.com"
    return actualHost.endsWith(suffix) && actualHost.length > suffix.length
  }
  return false
}

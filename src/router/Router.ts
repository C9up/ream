/**
 * Fluent Router — AdonisJS v6 compatible routing with controllers, resources, and groups.
 *
 * @implements FR24, FR25, FR26, FR27, FR28
 */

import type { HttpContext } from '../http/HttpContext.js'
import { safeDecodeURIComponent } from '../http/urlDecode.js'
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
  #route: RouteDefinition

  constructor(route: RouteDefinition) {
    this.#route = route
  }

  /** Name this route (for URL generation and redirects). */
  as(name: string): this {
    this.#route.name = name
    return this
  }

  /** Add named middleware. */
  middleware(...names: string[]): this {
    this.#route.middleware.push(...names)
    return this
  }

  /** Add inline middleware functions. */
  use(...mw: MiddlewareFunction[]): this {
    this.#route.inlineMiddleware.push(...mw)
    return this
  }

  /** Add authentication guards. */
  guard(...guards: string[]): this {
    this.#route.guards.push(...guards)
    return this
  }

  /** Require specific roles. */
  role(...roles: string[]): this {
    this.#route.roles.push(...roles)
    return this
  }

  /** Require specific permissions. */
  permission(...permissions: string[]): this {
    this.#route.permissions.push(...permissions)
    return this
  }

  /** Add a param constraint. */
  where(param: string, matcher: ParamMatcher | RegExp): this {
    this.#route.matchers[param] = matcher instanceof RegExp ? { pattern: matcher } : matcher
    return this
  }

  /**
   * Validate the request body against a named validator. At request time the
   * kernel resolves the validator from the IoC container under the token
   * `validator:<name>` and runs it after the auth guards and before the handler;
   * a failure short-circuits with `422 E_VALIDATION_ERROR` and the validated,
   * coerced payload is exposed on `ctx.request.validated()`. The same name also
   * feeds the OpenAPI generator's requestBody schema.
   *
   * Register the validator (any object with `validate(data) => { valid, errors,
   * data? }`, e.g. a `@c9up/rune` schema):
   *
   *     container.singleton('validator:createUser', () => schema({ ... }))
   *
   * An unregistered name is a hard error — validation is never silently skipped.
   */
  validate(validator: string): this {
    this.#route.validators.push(validator)
    return this
  }

  /** Set API version. */
  version(v: string): this {
    this.#route.version = v
    return this
  }

  /** Restrict to a specific domain. */
  domain(d: string): this {
    this.#route.domain = d
    return this
  }

  /** Mark as deprecated. */
  deprecates(version: string, options?: { sunset?: string }): this {
    this.#route.deprecates = { version, sunset: options?.sunset }
    return this
  }

  /** @internal Get the underlying definition. */
  getDefinition(): RouteDefinition {
    return this.#route
  }
}

// ─── GroupBuilder ───────────────────────────────────────────

/** Fluent group builder — returned by router.group(callback). */
export class GroupBuilder {
  #routes: RouteDefinition[]

  constructor(routes: RouteDefinition[]) {
    this.#routes = routes
  }

  /** Set URL prefix for all routes in the group. */
  prefix(p: string): this {
    for (const route of this.#routes) {
      route.path = p + route.path
    }
    return this
  }

  /** Add middleware to all routes in the group. */
  middleware(...names: string[]): this {
    for (const route of this.#routes) {
      route.middleware = [...names, ...route.middleware]
    }
    return this
  }

  /** Add inline middleware to all routes in the group. */
  use(...mw: MiddlewareFunction[]): this {
    for (const route of this.#routes) {
      route.inlineMiddleware = [...mw, ...route.inlineMiddleware]
    }
    return this
  }

  /** Add guards to all routes in the group. */
  guard(...guards: string[]): this {
    for (const route of this.#routes) {
      route.guards = [...guards, ...route.guards]
    }
    return this
  }

  /** Prefix route names for all routes in the group. */
  as(namePrefix: string): this {
    for (const route of this.#routes) {
      if (route.name) {
        route.name = `${namePrefix}.${route.name}`
      }
    }
    return this
  }

  /** Set domain for all routes in the group. */
  domain(d: string): this {
    for (const route of this.#routes) {
      route.domain = d
    }
    return this
  }

  /** Add param matcher to all routes in the group. */
  where(param: string, matcher: ParamMatcher | RegExp): this {
    const m = matcher instanceof RegExp ? { pattern: matcher } : matcher
    for (const route of this.#routes) {
      if (!(param in route.matchers)) {
        route.matchers[param] = m
      }
    }
    return this
  }
}

// ─── View engine helper ───────────────────────────────────────

interface ViewEngine {
  render(name: string, data?: Record<string, unknown>): Promise<string>
}

function isViewEngine(value: unknown): value is ViewEngine {
  return (
    value !== null &&
    typeof value === 'object' &&
    'render' in value &&
    typeof value.render === 'function'
  )
}

// ─── OnRouteBuilder ─────────────────────────────────────────

/** Builder for on(path).render(view) and on(path).redirect(target). */
export class OnRouteBuilder {
  #router: Router
  #path: string

  constructor(router: Router, path: string) {
    this.#router = router
    this.#path = path
  }

  /** Render a view (requires Photon/view provider). */
  render(view: string, data?: Record<string, unknown>): RouteBuilder {
    return this.#router.get(this.#path, async (ctx) => {
      const raw = ctx.store.get('view')
      if (!isViewEngine(raw)) {
        throw new Error('View engine not configured. Register a view provider (Photon) first.')
      }
      const viewEngine = raw
      const html = await viewEngine.render(view, data)
      ctx.response.type('text/html; charset=utf-8').send(html)
    })
  }

  /** Redirect to a path. */
  redirect(target: string, status = 302): RouteBuilder {
    return this.#router.get(this.#path, async (ctx) => {
      ctx.response.redirect().status(status).toPath(target)
    })
  }

  /** Redirect to a named route. */
  redirectToRoute(name: string, params?: Record<string, string>, status = 302): RouteBuilder {
    return this.#router.get(this.#path, async (ctx) => {
      ctx.response.redirect().status(status).toRoute(name, params)
    })
  }
}

// ─── Router ─────────────────────────────────────────────────

/** Main Router. */
export class Router {
  #routes: RouteDefinition[] = []
  #globalMatchers: Record<string, ParamMatcher> = {}
  #routerMiddleware: MiddlewareFunction[] = []
  #namedMiddleware: Map<string, MiddlewareFunction> = new Map()

  /** Index: static routes by "METHOD:path" for O(1) exact match. */
  #staticIndex: Map<string, RouteDefinition> = new Map()
  /** Index: parametric routes grouped by method. */
  #paramIndex: Map<string, RouteDefinition[]> = new Map()
  /** Index: named routes for O(1) URL generation. */
  #nameIndex: Map<string, RouteDefinition> = new Map()
  /** Whether the index needs rebuilding. */
  #indexDirty = true

  /** Predefined param matchers. */
  readonly matchers = matchers

  // ─── Router-level middleware (like AdonisJS) ──────────────

  /**
   * Register router-level middleware (runs on requests with a matched route).
   *   router.use([() => import('#middleware/auth_middleware')])
   */
  use(middleware: MiddlewareEntry[]): this {
    for (const mw of middleware) {
      this.#routerMiddleware.push(resolveMiddlewareEntry(mw))
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
      this.#namedMiddleware.set(name, fn)
      resolved[name] = fn
    }
    return resolved
  }

  /** Get the router-level middleware stack. */
  getRouterMiddleware(): MiddlewareFunction[] {
    return [...this.#routerMiddleware]
  }

  /** Get a named middleware by name. */
  getNamedMiddleware(name: string): MiddlewareFunction | undefined {
    return this.#namedMiddleware.get(name)
  }

  // ─── Route registration ───────────────────────────────────

  /** Register a route with any HTTP method. */
  route(method: string, path: string, handler: RouteHandler): RouteBuilder {
    const def = this.#createDefinition(method, path, handler)
    this.#routes.push(def)
    this.#indexDirty = true
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
      const def = this.#createDefinition(method, `/${path}${suffix}`, [controller, action])
      def.name = `${baseName}.${nameSuffix}`
      routes.push(def)
      this.#routes.push(def)
    }
    this.#indexDirty = true

    return new GroupBuilder(routes)
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
  group(
    config: {
      prefix?: string
      middleware?: string[]
      guards?: string[]
      roles?: string[]
      permissions?: string[]
    },
    callback: (router: Router) => void,
  ): void
  group(
    callbackOrConfig:
      | (() => void)
      | {
          prefix?: string
          middleware?: string[]
          guards?: string[]
          roles?: string[]
          permissions?: string[]
        },
    legacyCallback?: (router: Router) => void,
  ): GroupBuilder | undefined {
    if (typeof callbackOrConfig === 'function') {
      // AdonisJS-style: group(() => { ... }).prefix().middleware()
      const snapshot = this.#routes.length
      callbackOrConfig()
      const newRoutes = this.#routes.slice(snapshot)
      return new GroupBuilder(newRoutes)
    }

    // Legacy-style: group({ prefix, guards }, (r) => { ... })
    const config = callbackOrConfig
    const childRouter = new Router()
    legacyCallback?.(childRouter)

    for (const route of childRouter.#routes) {
      this.#routes.push({
        ...route,
        path: (config.prefix ?? '') + route.path,
        middleware: [...(config.middleware ?? []), ...route.middleware],
        guards: [...(config.guards ?? []), ...route.guards],
        roles: [...(config.roles ?? []), ...route.roles],
        permissions: [...(config.permissions ?? []), ...route.permissions],
      })
    }
    this.#indexDirty = true
  }

  // ─── On (view/redirect shortcuts) ─────────────────────────

  /** Create a view/redirect route shortcut. */
  on(path: string): OnRouteBuilder {
    return new OnRouteBuilder(this, path)
  }

  // ─── Global matchers ──────────────────────────────────────

  /** Set a global param matcher (applied to all routes). */
  where(param: string, matcher: ParamMatcher | RegExp): this {
    this.#globalMatchers[param] = matcher instanceof RegExp ? { pattern: matcher } : matcher
    return this
  }

  // ─── Route matching ───────────────────────────────────────

  /** Build route indexes for fast matching. Called lazily on first match. */
  #buildIndex(): void {
    this.#staticIndex.clear()
    this.#paramIndex.clear()
    this.#nameIndex.clear()

    for (const route of this.#routes) {
      // Named route index
      if (route.name) {
        this.#nameIndex.set(route.name, route)
      }

      const isParam = route.path.includes(':') || route.path.includes('*')

      if (!isParam && !route.domain) {
        // Static route — O(1) exact match
        const key = route.method === '*' ? `*:${route.path}` : `${route.method}:${route.path}`
        this.#staticIndex.set(key, route)
      } else {
        // Parametric route — indexed by method
        const methods =
          route.method === '*'
            ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
            : [route.method]
        for (const m of methods) {
          if (!this.#paramIndex.has(m)) this.#paramIndex.set(m, [])
          this.#paramIndex.get(m)?.push(route)
        }
      }
    }

    this.#indexDirty = false
  }

  /** Find a matching route, extracting :param values and validating matchers. */
  match(method: string, path: string, host?: string): MatchResult | undefined {
    if (this.#indexDirty) this.#buildIndex()

    const candidates = [path]
    // Trailing-slash normalisation: `/users/` should match `/users`. Done as
    // a fallback (not a primary rewrite) so a route declared as `/users/`
    // still wins its exact match before we try the trimmed form.
    if (path.length > 1 && path.endsWith('/')) {
      candidates.push(path.slice(0, -1))
    }

    for (const candidatePath of candidates) {
      // 1. Try static exact match (O(1))
      const staticRoute =
        this.#staticIndex.get(`${method}:${candidatePath}`) ??
        this.#staticIndex.get(`*:${candidatePath}`)
      if (staticRoute) {
        if (!staticRoute.domain || !host || matchDomain(staticRoute.domain, host)) {
          return { route: staticRoute, params: {} }
        }
      }

      // 2. Try parametric routes (only same-method candidates)
      const paramCandidates = this.#paramIndex.get(method) ?? []
      for (const route of paramCandidates) {
        if (route.domain && host && !matchDomain(route.domain, host)) continue

        const params = matchPath(route.path, candidatePath)
        if (params === null) continue

        if (!this.#validateMatchers(params, route.matchers)) continue
        if (!this.#validateMatchers(params, this.#globalMatchers)) continue

        return { route, params }
      }
    }

    // HEAD falls back to the matching GET route (RFC 9110 §9.3.2 semantics —
    // same headers, no body). Without this, `curl -I` and LB health probes
    // 404 on every GET-only route.
    if (method === 'HEAD') {
      return this.match('GET', path, host)
    }

    return undefined
  }

  // ─── URL generation ───────────────────────────────────────

  /** Generate a URL from a named route. */
  makeUrl(name: string, params?: Record<string, string>): string {
    if (this.#indexDirty) this.#buildIndex()
    const route = this.#nameIndex.get(name)
    if (!route) {
      throw new Error(
        `Route '${name}' not found. Available: ${this.#routes
          .filter((r) => r.name)
          .map((r) => r.name)
          .join(', ')}`,
      )
    }
    let url = route.path
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        // Word-boundary substitution: a bare `.replace(':id')` would corrupt
        // `:idx` (`/x/:idx` → `/x/42x`). The lookahead requires the param name
        // to END at the placeholder boundary. Keys are validated identifiers
        // in route paths, but escape defensively (caller-supplied object).
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        url = url.replace(new RegExp(`:${escaped}\\??(?![\\w])`, 'g'), encodeURIComponent(value))
      }
    }
    // Strip remaining optional placeholders (`:name?` segments not provided).
    url = url.replace(/\/:[A-Za-z_][\w]*\?/g, '')
    // Any remaining `:foo` is a required param the caller forgot. Surface it
    // as a configuration error rather than emitting a broken URL.
    const missing = url.match(/:[A-Za-z_][\w]*/g)
    if (missing && missing.length > 0) {
      throw new Error(
        `Cannot generate URL for route '${name}': missing params ${missing.join(', ')}`,
      )
    }
    return url
  }

  // ─── Accessors ────────────────────────────────────────────

  /** Get all registered routes (for OpenAPI generation, introspection). */
  getRoutes(): RouteDefinition[] {
    return [...this.#routes]
  }

  /**
   * Clear all registered routes AND registries (used by hot-reload). Router
   * middleware, named middleware, and global matchers are reset too — the
   * preloads that registered them re-run on reload, so keeping them would
   * accumulate duplicates (middleware executing N+1 times after N reloads).
   */
  clear(): void {
    this.#routes = []
    this.#routerMiddleware = []
    this.#namedMiddleware.clear()
    this.#globalMatchers = {}
    this.#indexDirty = true
  }

  get routeCount(): number {
    return this.#routes.length
  }

  // ─── Internals ────────────────────────────────────────────

  #createDefinition(method: string, path: string, handler: RouteHandler): RouteDefinition {
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

  #validateMatchers(
    params: Record<string, string>,
    matcherMap: Record<string, ParamMatcher>,
  ): boolean {
    for (const [param, value] of Object.entries(params)) {
      const matcher = matcherMap[param]
      if (!matcher) continue
      const regex = matcher instanceof RegExp ? matcher : matcher.pattern
      // A user-supplied /g or /y regex is stateful (`lastIndex` advances on
      // match) — without a reset, the same URL alternates match/no-match
      // across requests. Reset before every test.
      if (regex.global || regex.sticky) regex.lastIndex = 0
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

  // Catch-all wildcard: `/assets/*` greedily swallows the remainder of the
  // path into a `*` param. The wildcard must be the final segment — any
  // pattern after it would never match.
  const wildcardIdx = patternParts.indexOf('*')
  if (wildcardIdx !== -1) {
    if (wildcardIdx !== patternParts.length - 1) return null
    if (actualParts.length < wildcardIdx + 1) return null
    const params: Record<string, string> = {}
    for (let i = 0; i < wildcardIdx; i++) {
      const part = patternParts[i]
      if (part.startsWith(':')) {
        params[part.substring(1)] = safeDecodeURIComponent(actualParts[i])
      } else if (part !== actualParts[i]) {
        return null
      }
    }
    // Decode per segment, then rejoin — an encoded `/` inside a segment stays
    // a value character, the path structure was already split on raw `/`.
    params['*'] = actualParts
      .slice(wildcardIdx)
      .map((s) => safeDecodeURIComponent(s))
      .join('/')
    return params
  }

  // Count required (non-optional) pattern parts
  const requiredCount = patternParts.filter((p) => !p.endsWith('?')).length
  const maxCount = patternParts.length

  if (actualParts.length < requiredCount || actualParts.length > maxCount) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]
    const isOptional = part.endsWith('?')

    if (part.startsWith(':')) {
      const paramName = isOptional ? part.slice(1, -1) : part.substring(1)
      if (i < actualParts.length) {
        // Percent-decode the captured segment (query strings already are) so
        // `/users/Jos%C3%A9` yields `José` and matchers test the real value.
        // safeDecode falls back to the raw segment on malformed input.
        params[paramName] = safeDecodeURIComponent(actualParts[i])
      }
      // Optional param with no actual part — skip (param not set)
    } else if (i < actualParts.length && part !== actualParts[i]) {
      return null
    } else if (i >= actualParts.length && !isOptional) {
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

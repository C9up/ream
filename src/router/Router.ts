/**
 * Fluent Router — AdonisJS v6 compatible routing with controllers, resources, and groups.
 *
 * @implements FR24, FR25, FR26, FR27, FR28
 */

import type { HttpContext } from '../http/HttpContext.js'
import { safeDecodeURIComponent } from '../http/urlDecode.js'
import type { MiddlewareFunction } from '../middleware/Pipeline.js'
import type { SignedUrl } from '../security/SignedUrl.js'
import type { MiddlewareEntry } from '../server/Server.js'
import { resolveMiddlewareEntry, resolveParametrizedMiddlewareEntry } from '../server/Server.js'
import { singular, snakeCase } from '../utils/inflect.js'
import { Macroable } from '../utils/Macroable.js'

/** Options for {@link Router.makeSignedUrl}. */
export interface SignedUrlOptions {
  /** Extra query-string params folded into the signature. */
  qs?: Record<string, string>
  /** Lifetime before the link expires — seconds (number) or a `'30m'`/`'2h'`/`'1d'` string. */
  expiresIn?: string | number
  /** Namespaces the signature so a URL signed for one purpose can't be reused for another. */
  purpose?: string
}

// ─── Types ──────────────────────────────────────────────────

export type RouteHandlerFunction = (ctx: HttpContext) => Promise<void> | void

/**
 * Controller tuple: [ControllerClass, 'methodName'].
 * Constructor params are resolved by the IoC container, not by TypeScript —
 * same pattern as AdonisJS (@poppinss/utils Constructor type).
 */
// biome-ignore lint/suspicious/noExplicitAny: required — TypeScript contravariance makes it impossible to type "any constructor" without `any`
export type ControllerAction = [target: new (...args: any[]) => any, method: string]

/** Any controller class (derived from {@link ControllerAction} — no fresh `any`). */
export type ControllerConstructor = ControllerAction[0]

/** A lazy controller import: `() => import('#controllers/users_controller')`. */
export type LazyControllerImport = () => Promise<{ default: ControllerConstructor }>

/** Lazy controller tuple: [() => import(...), 'methodName']. */
export type LazyControllerAction = [loader: LazyControllerImport, method: string]

/**
 * A route handler is a closure, a controller tuple, a lazy-import tuple, or a
 * magic string reference `'ControllerName.method'` resolved through the
 * router's controller registry ({@link Router.controllers}).
 */
export type RouteHandler = RouteHandlerFunction | ControllerAction | LazyControllerAction | string

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
  /**
   * Soft-delete flag (AdonisJS `route.markAsDeleted()`). A resource's
   * `.only()`/`.except()`/`.apiOnly()` mark filtered-out routes deleted rather
   * than splicing them, so the builder chain stays intact. Deleted routes are
   * skipped by the match index and `getRoutes()`.
   */
  deleted?: boolean
  /**
   * Lazily-imported controller (from a `[() => import(...), 'method']` tuple or
   * a resolved string reference). The HttpKernel awaits the loader on first
   * request and promotes it to {@link controller}, so @Guard metadata + DI
   * resolution flow through the normal controller path.
   */
  lazyController?: { loader: LazyControllerImport; method: string }
  /**
   * Unresolved `'ControllerName.method'` string reference. Resolved to
   * {@link lazyController} against the router's controller registry when the
   * route index is (re)built — a reference to an unregistered controller is a
   * hard error there.
   */
  stringRef?: { controller: string; method: string }
}

/**
 * Distinguish a lazy-import loader from a controller class in a handler tuple.
 * Arrow/plain function loaders (`() => import(...)`) have no own `prototype`
 * property; class constructors do.
 */
function isLazyControllerLoader(
  first: ControllerConstructor | LazyControllerImport,
): first is LazyControllerImport {
  return !('prototype' in first)
}

/** Build a route definition from a method, path, and handler. */
function makeDefinition(method: string, path: string, handler: RouteHandler): RouteDefinition {
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

  if (typeof handler === 'string') {
    // Magic string reference 'ControllerName.method' — split on the LAST dot so
    // controller names may themselves be dotted; resolved at #buildIndex time.
    const dot = handler.lastIndexOf('.')
    if (dot <= 0 || dot === handler.length - 1) {
      throw new Error(
        `Invalid controller reference "${handler}" — expected the form "ControllerName.method".`,
      )
    }
    def.stringRef = { controller: handler.slice(0, dot), method: handler.slice(dot + 1) }
  } else if (Array.isArray(handler)) {
    const [first, methodName] = handler
    if (isLazyControllerLoader(first)) {
      def.lazyController = { loader: first, method: methodName }
    } else {
      def.controller = { target: first, method: methodName }
    }
  } else {
    def.handler = handler
  }

  return def
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

/**
 * Normalise a param matcher into the internal `{ pattern }` shape.
 *
 * A string matcher (AdonisJS `.where('id', '[0-9]+')`) is compiled to an
 * anchored RegExp. AdonisJS builds `new RegExp(matcher)` unanchored and relies
 * on `matchit`'s per-segment anchoring; ream tests matchers per-segment without
 * that implicit anchoring (and its predefined matchers are already `^…$`), so
 * anchoring here reproduces AdonisJS's *effective* full-segment semantics.
 */
function compileMatcher(matcher: ParamMatcher | RegExp | string): ParamMatcher {
  if (typeof matcher === 'string') return { pattern: new RegExp(`^(?:${matcher})$`) }
  return matcher instanceof RegExp ? { pattern: matcher } : matcher
}

// ─── RouteBuilder ───────────────────────────────────────────

/**
 * Fluent route builder — mutates the already-registered route definition(s).
 * Backed by an array so a multi-verb `router.route(['GET','POST'], …)` returns
 * ONE builder that fans every mutation across all its verbs; the single-verb
 * helpers (`get`/`post`/…) back it with a one-element array.
 */
export class RouteBuilder extends Macroable {
  #routes: RouteDefinition[]

  constructor(routes: RouteDefinition | RouteDefinition[]) {
    super()
    this.#routes = Array.isArray(routes) ? routes : [routes]
  }

  /** Apply `fn` to every backing definition, returning `this` for chaining. */
  #each(fn: (route: RouteDefinition) => void): this {
    for (const route of this.#routes) fn(route)
    return this
  }

  /** The primary definition — accessors read from it (all verbs share pattern/name). */
  #primary(): RouteDefinition {
    return this.#routes[0]
  }

  /** Name this route (for URL generation and redirects). */
  as(name: string): this {
    return this.#each((route) => {
      route.name = name
    })
  }

  /** Prepend a URL prefix to this single route (AdonisJS route-level `prefix`). */
  prefix(prefix: string): this {
    return this.#each((route) => {
      route.path = prefix + route.path
    })
  }

  /** Add named middleware. */
  middleware(...names: string[]): this {
    return this.#each((route) => {
      route.middleware.push(...names)
    })
  }

  /** Add inline middleware functions. */
  use(...mw: MiddlewareFunction[]): this {
    return this.#each((route) => {
      route.inlineMiddleware.push(...mw)
    })
  }

  /** Add authentication guards. */
  guard(...guards: string[]): this {
    return this.#each((route) => {
      route.guards.push(...guards)
    })
  }

  /** Require specific roles. */
  role(...roles: string[]): this {
    return this.#each((route) => {
      route.roles.push(...roles)
    })
  }

  /** Require specific permissions. */
  permission(...permissions: string[]): this {
    return this.#each((route) => {
      route.permissions.push(...permissions)
    })
  }

  /** Add a param constraint — RegExp, predefined matcher, or a string pattern. */
  where(param: string, matcher: ParamMatcher | RegExp | string): this {
    const compiled = compileMatcher(matcher)
    return this.#each((route) => {
      route.matchers[param] = compiled
    })
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
    return this.#each((route) => {
      route.validators.push(validator)
    })
  }

  /** Set API version. */
  version(v: string): this {
    return this.#each((route) => {
      route.version = v
    })
  }

  /** Restrict to a specific domain. */
  domain(d: string): this {
    return this.#each((route) => {
      route.domain = d
    })
  }

  /** Mark as deprecated. */
  deprecates(version: string, options?: { sunset?: string }): this {
    return this.#each((route) => {
      route.deprecates = { version, sunset: options?.sunset }
    })
  }

  /** The route's name, or undefined when unnamed (AdonisJS `route.getName`). */
  getName(): string | undefined {
    return this.#primary().name
  }

  /** The route's URL pattern (AdonisJS `route.getPattern`). */
  getPattern(): string {
    return this.#primary().path
  }

  /** Replace the route's URL pattern (AdonisJS `route.setPattern`). */
  setPattern(pattern: string): this {
    return this.#each((route) => {
      route.path = pattern
    })
  }

  /** Soft-delete this route so it stops matching (AdonisJS `route.markAsDeleted`). */
  markAsDeleted(): this {
    return this.#each((route) => {
      route.deleted = true
    })
  }

  /** True when the route has been soft-deleted (AdonisJS `route.isDeleted`). */
  isDeleted(): boolean {
    return this.#primary().deleted === true
  }

  /** @internal Get the underlying (primary) definition. */
  getDefinition(): RouteDefinition {
    return this.#primary()
  }
}

// ─── GroupBuilder ───────────────────────────────────────────

/** Fluent group builder — returned by router.group(callback). */
export class GroupBuilder extends Macroable {
  #routes: RouteDefinition[]

  constructor(routes: RouteDefinition[]) {
    super()
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

  /**
   * Prefix route names for all routes in the group (AdonisJS `group.as`).
   * Every route MUST already be named — prefixing an unnamed route is
   * meaningless, so it throws rather than silently skipping (AdonisJS parity).
   */
  as(namePrefix: string): this {
    for (const route of this.#routes) {
      if (!route.name) {
        throw new Error(
          `[E_MISSING_ROUTE_NAME] Cannot apply group name "${namePrefix}": route ${route.method} ${route.path} has no name. Name every route in a named group (\`.as(...)\`), or move the unnamed route out of the group.`,
        )
      }
      route.name = `${namePrefix}.${route.name}`
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
  where(param: string, matcher: ParamMatcher | RegExp | string): this {
    const m = compileMatcher(matcher)
    for (const route of this.#routes) {
      if (!(param in route.matchers)) {
        route.matchers[param] = m
      }
    }
    return this
  }
}

// ─── RouteResource ──────────────────────────────────────────

/** Resourceful action names (AdonisJS resource). */
export type ResourceAction = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'

/** Middleware accepted per-action on a resource: a named string or an inline fn. */
type ResourceMiddleware = string | MiddlewareFunction

/**
 * Resourceful route builder — returned by `router.resource()` /
 * `router.shallowResource()` (AdonisJS `RouteResource` parity).
 *
 * Generates the seven RESTful routes (index, create, store, show, edit,
 * update, destroy — `update` registered for both PUT and PATCH) and exposes
 * the fluent filtering/config API: `only`/`except`/`apiOnly`/`params`/`tap`/
 * `where`/`use`/`middleware`/`as`. Nested resources use dot-notation
 * (`posts.comments` → `/posts/:post_id/comments/:id`).
 */
export class RouteResource extends Macroable {
  #resource: string
  #controller: ControllerAction[0]
  #shallow: boolean
  #register: (def: RouteDefinition) => void
  #markDirty: () => void
  /** Resource name → param placeholder (`comments` → `:id`, `posts` → `:post_id`). */
  #params: Record<string, string> = {}
  #baseName: string

  /** The generated routes, in declaration order (AdonisJS `resource.routes`). */
  readonly routes: RouteBuilder[] = []

  constructor(options: {
    resource: string
    controller: ControllerAction[0]
    shallow: boolean
    register: (def: RouteDefinition) => void
    markDirty: () => void
  }) {
    super()
    const resource = options.resource.replace(/^\//, '').replace(/\/$/, '')
    if (!resource) throw new Error(`Invalid resource name "${options.resource}"`)
    this.#resource = resource
    this.#controller = options.controller
    this.#shallow = options.shallow
    this.#register = options.register
    this.#markDirty = options.markDirty
    this.#baseName = resource.split('.').map(snakeCase).join('.')
    this.#buildRoutes()
  }

  #createRoute(pattern: string, method: string, action: ResourceAction): void {
    const def = makeDefinition(method, `/${pattern}`, [this.#controller, action])
    def.name = `${this.#baseName}.${action}`
    this.#register(def)
    this.routes.push(new RouteBuilder(def))
  }

  #buildRoutes(): void {
    const segments = this.#resource.split('.')
    const main = segments.pop() ?? this.#resource
    this.#params[main] = ':id'

    const parentPath = segments
      .map((parent) => {
        const param = `:${snakeCase(singular(parent))}_id`
        this.#params[parent] = param
        return `${parent}/${param}`
      })
      .join('/')

    const baseURI = parentPath ? `${parentPath}/${main}` : main
    // Shallow member routes drop the parent prefix — the id alone identifies
    // the record (AdonisJS shallow resources).
    const memberBase = this.#shallow ? main : baseURI

    this.#createRoute(baseURI, 'GET', 'index')
    this.#createRoute(`${baseURI}/create`, 'GET', 'create')
    this.#createRoute(baseURI, 'POST', 'store')
    this.#createRoute(`${memberBase}/:id`, 'GET', 'show')
    this.#createRoute(`${memberBase}/:id/edit`, 'GET', 'edit')
    this.#createRoute(`${memberBase}/:id`, 'PUT', 'update')
    this.#createRoute(`${memberBase}/:id`, 'PATCH', 'update')
    this.#createRoute(`${memberBase}/:id`, 'DELETE', 'destroy')
  }

  /** Routes whose name ends with one of `names` (the action suffix). */
  #matching(names: string[]): RouteBuilder[] {
    return this.routes.filter((route) => {
      const name = route.getName()
      return name !== undefined && names.some((action) => name.endsWith(action))
    })
  }

  /** Keep only the given actions; soft-delete the rest (AdonisJS `only`). */
  only(names: ResourceAction[]): this {
    const keep = new Set(this.#matching(names))
    for (const route of this.routes) if (!keep.has(route)) route.markAsDeleted()
    this.#markDirty()
    return this
  }

  /** Register all actions except the given ones (AdonisJS `except`). */
  except(names: ResourceAction[]): this {
    for (const route of this.#matching(names)) route.markAsDeleted()
    this.#markDirty()
    return this
  }

  /** Drop the form-rendering `create` + `edit` actions (AdonisJS `apiOnly`). */
  apiOnly(): this {
    return this.except(['create', 'edit'])
  }

  /** Constrain a param across every action route (AdonisJS `resource.where`). */
  where(key: string, matcher: ParamMatcher | RegExp | string): this {
    for (const route of this.routes) route.where(key, matcher)
    return this
  }

  /**
   * Configure the resource's routes. `tap(cb)` runs `cb` for every non-deleted
   * route; `tap(actions, cb)` only for routes matching `actions` (AdonisJS `tap`).
   */
  tap(callback: (route: RouteBuilder) => void): this
  tap(actions: ResourceAction | ResourceAction[], callback: (route: RouteBuilder) => void): this
  tap(
    actionsOrCallback: ResourceAction | ResourceAction[] | ((route: RouteBuilder) => void),
    callback?: (route: RouteBuilder) => void,
  ): this {
    if (typeof actionsOrCallback === 'function') {
      for (const route of this.routes) if (!route.isDeleted()) actionsOrCallback(route)
      return this
    }
    const names = Array.isArray(actionsOrCallback) ? actionsOrCallback : [actionsOrCallback]
    if (callback) {
      for (const route of this.#matching(names)) if (!route.isDeleted()) callback(route)
    }
    return this
  }

  /** Rename the `:id` param of one or more resources (AdonisJS `params`). */
  params(resources: Record<string, string>): this {
    for (const [resource, param] of Object.entries(resources)) {
      const existing = this.#params[resource]
      if (!existing) continue
      this.#params[resource] = `:${param}`
      for (const route of this.routes) {
        route.setPattern(
          route.getPattern().replace(`${resource}/${existing}`, `${resource}/:${param}`),
        )
      }
    }
    this.#markDirty()
    return this
  }

  /**
   * Attach middleware to specific actions (or `'*'` for all) — AdonisJS `use`.
   * Named middleware are strings; inline middleware are functions.
   */
  use(
    actions: ResourceAction | ResourceAction[] | '*',
    middleware: ResourceMiddleware | ResourceMiddleware[],
  ): this {
    const list = Array.isArray(middleware) ? middleware : [middleware]
    const apply = (route: RouteBuilder): void => {
      for (const mw of list) {
        if (typeof mw === 'string') route.middleware(mw)
        else route.use(mw)
      }
    }
    if (actions === '*') this.tap(apply)
    else this.tap(actions, apply)
    return this
  }

  /** Alias for {@link RouteResource.use} (AdonisJS `middleware`). */
  middleware(
    actions: ResourceAction | ResourceAction[] | '*',
    middleware: ResourceMiddleware | ResourceMiddleware[],
  ): this {
    return this.use(actions, middleware)
  }

  /**
   * Rename the base of every route name (AdonisJS `as`). `normalizeName`
   * snake_cases the new base by default.
   */
  as(name: string, normalizeName = true): this {
    const newBase = normalizeName ? snakeCase(name) : name
    for (const route of this.routes) {
      const current = route.getName()
      if (current) route.as(current.replace(this.#baseName, newBase))
    }
    this.#baseName = newBase
    this.#markDirty()
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

/** Builder for on(path).render(view) and on(path).redirect(namedRoute). */
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

  /**
   * Redirect to a NAMED route (AdonisJS brisk `redirect`). Mirrors AdonisJS:
   * the first argument is a route name, not a path — use {@link redirectToPath}
   * for a fixed URL.
   */
  redirect(name: string, params?: Record<string, string>, status = 302): RouteBuilder {
    return this.#router.get(this.#path, async (ctx) => {
      ctx.response.redirect().status(status).toRoute(name, params)
    })
  }

  /** Redirect to a fixed path/URL (AdonisJS brisk `redirectToPath`). */
  redirectToPath(target: string, status = 302): RouteBuilder {
    return this.#router.get(this.#path, async (ctx) => {
      ctx.response.redirect().status(status).toPath(target)
    })
  }
}

// ─── Router ─────────────────────────────────────────────────

/** Main Router. */
export class Router extends Macroable {
  #routes: RouteDefinition[] = []
  #globalMatchers: Record<string, ParamMatcher> = {}
  #routerMiddleware: MiddlewareFunction[] = []
  #namedMiddleware: Map<string, MiddlewareFunction> = new Map()
  /** Controller registry: name → lazy import, for string handler references. */
  #controllers: Map<string, LazyControllerImport> = new Map()
  /** APP_KEY-backed signed-URL helper (injected by the Ignitor when set). */
  #signedUrl?: SignedUrl

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
   * Register a named middleware collection and return per-name FACTORIES
   * (AdonisJS `defineNamedMiddleware`). Call a factory to bind per-route
   * arguments, then attach the result inline:
   *
   *   export const middleware = router.named({
   *     auth: () => import('#middleware/auth_middleware'),
   *   })
   *   router.get('/admin', [AdminController, 'index']).use([middleware.auth({ guards: ['web'] })])
   *
   * By-name usage (`route.middleware('auth')`) still runs the middleware with
   * no arguments — the factory form is only needed to pass `args` to `handle`.
   */
  named(
    collection: Record<string, MiddlewareEntry>,
  ): Record<string, (args?: unknown) => MiddlewareFunction> {
    const factories: Record<string, (args?: unknown) => MiddlewareFunction> = {}
    for (const [name, mw] of Object.entries(collection)) {
      // By-name resolution (`route.middleware('auth')`) uses the no-arg form.
      this.#namedMiddleware.set(name, resolveMiddlewareEntry(mw))
      // The returned factory bakes in per-route args for inline `.use()`.
      factories[name] = resolveParametrizedMiddlewareEntry(mw)
    }
    return factories
  }

  /**
   * Register controllers for magic string handler references (AdonisJS lazy
   * controller pattern). Each entry maps a controller name to a lazy import:
   *
   *   router.controllers({ UsersController: () => import('#controllers/users_controller') })
   *   router.get('/users', 'UsersController.index')
   *
   * The class is imported on first request and resolved through the IoC
   * container (so @inject + @Guard/@Role decorators work). A string reference
   * to a name that was never registered fails loudly when the route index is
   * built.
   */
  controllers(map: Record<string, LazyControllerImport>): this {
    for (const [name, loader] of Object.entries(map)) {
      this.#controllers.set(name, loader)
    }
    this.#indexDirty = true
    return this
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

  /**
   * Register a route for one verb or several (AdonisJS `route(pattern, methods)`
   * accepts an array). A multi-verb call returns a single builder that
   * configures every verb at once.
   */
  route(method: string | string[], path: string, handler: RouteHandler): RouteBuilder {
    const methods = Array.isArray(method) ? method : [method]
    const defs = methods.map((verb) => {
      const def = this.#createDefinition(verb, path, handler)
      this.#routes.push(def)
      return def
    })
    this.#indexDirty = true
    return new RouteBuilder(defs)
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
   * Register resourceful routes for a controller (AdonisJS `resource`).
   *
   * Generates index / create / store / show / edit / update / destroy —
   * `update` for both PUT and PATCH. Returns a {@link RouteResource} for
   * fluent filtering: `.only()`, `.except()`, `.apiOnly()`, `.params()`,
   * `.tap()`, `.where()`, `.use()`, `.as()`.
   *
   * Nested resources use dot-notation (`posts.comments` →
   * `/posts/:post_id/comments/:id`).
   *
   * Usage:
   *   router.resource('posts', PostsController)
   *   router.resource('posts', PostsController).apiOnly()
   */
  resource(path: string, controller: ControllerAction[0]): RouteResource {
    return new RouteResource({
      resource: path,
      controller,
      shallow: false,
      register: (def) => {
        this.#routes.push(def)
        this.#indexDirty = true
      },
      markDirty: () => {
        this.#indexDirty = true
      },
    })
  }

  /**
   * Register a shallow resource (AdonisJS `shallowResource`). Member routes
   * (show/edit/update/destroy) drop the parent prefix, since the record id
   * alone identifies it: `posts.comments` → `/comments/:id` for members but
   * `/posts/:post_id/comments` for the collection.
   */
  shallowResource(path: string, controller: ControllerAction[0]): RouteResource {
    return new RouteResource({
      resource: path,
      controller,
      shallow: true,
      register: (def) => {
        this.#routes.push(def)
        this.#indexDirty = true
      },
      markDirty: () => {
        this.#indexDirty = true
      },
    })
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
  where(param: string, matcher: ParamMatcher | RegExp | string): this {
    this.#globalMatchers[param] = compileMatcher(matcher)
    return this
  }

  // ─── Route matching ───────────────────────────────────────

  /** Build route indexes for fast matching. Called lazily on first match. */
  #buildIndex(): void {
    this.#staticIndex.clear()
    this.#paramIndex.clear()
    this.#nameIndex.clear()

    for (const route of this.#routes) {
      // Soft-deleted routes (resource .only()/.except()/.apiOnly()) never match.
      if (route.deleted) continue
      // Resolve a string handler reference against the controller registry.
      if (route.stringRef && !route.lazyController) {
        const loader = this.#controllers.get(route.stringRef.controller)
        if (!loader) {
          throw new Error(
            `[E_UNREGISTERED_CONTROLLER] Route ${route.method} ${route.path} references ` +
              `controller '${route.stringRef.controller}', which is not registered. Register it ` +
              `with router.controllers({ ${route.stringRef.controller}: () => import('...') }).`,
          )
        }
        route.lazyController = { loader, method: route.stringRef.method }
      }
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

  /**
   * Generate a URL from a named route — the canonical URL builder (AdonisJS v7
   * `urlFor` parity). Fills `:param` placeholders, strips unprovided optional
   * segments, and throws on an unknown name or a missing required param.
   */
  urlFor(name: string, params?: Record<string, string>): string {
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

  /**
   * @deprecated Use {@link urlFor} — AdonisJS v7 renamed `makeUrl` → `urlFor`.
   * Retained as a thin alias so existing callers keep working.
   */
  makeUrl(name: string, params?: Record<string, string>): string {
    return this.urlFor(name, params)
  }

  /** @internal Inject the APP_KEY-backed signed-URL helper (wired by the Ignitor). */
  setSignedUrl(signedUrl: SignedUrl): void {
    this.#signedUrl = signedUrl
  }

  /**
   * Generate a tamper-proof signed URL for a named route (AdonisJS
   * `makeSignedUrl`). Delegates to the {@link SignedUrl} helper: appends an HMAC
   * `signature`, plus a signed `expires` timestamp when `expiresIn` is given.
   * Verified on the request side by `request.hasValidSignature()`.
   *
   * Requires an APP_KEY-backed signer (registered when `APP_KEY` is set).
   */
  makeSignedUrl(name: string, params?: Record<string, string>, options?: SignedUrlOptions): string {
    if (!this.#signedUrl) {
      throw new Error(
        '[E_NO_APP_KEY] makeSignedUrl() requires an APP_KEY-backed signer. Set APP_KEY (>= 16 chars) so the encryption service is registered.',
      )
    }
    const path = this.urlFor(name, params)
    const withQs = options?.qs ? `${path}?${new URLSearchParams(options.qs).toString()}` : path
    return this.#signedUrl.make(withQs, {
      expiresIn: options?.expiresIn,
      purpose: options?.purpose,
    })
  }

  /**
   * Map of every NAMED route's `name` → path pattern, e.g.
   * `{ 'users.show': '/users/:id' }`. Serialize this into a page so a
   * browser-side `urlFor(name, params)` can build URLs without shipping the full
   * route table — only named routes are exposed; unnamed routes stay private to
   * the server. Powers the aurora client URL helper.
   */
  namedManifest(): Record<string, string> {
    if (this.#indexDirty) this.#buildIndex()
    const manifest: Record<string, string> = {}
    for (const [name, route] of this.#nameIndex) {
      manifest[name] = route.path
    }
    return manifest
  }

  /**
   * Generate a TypeScript source string typing every named route and its
   * params (AdonisJS `generateTypes`) — a `RouteName` union plus a
   * `RouteParams` map inferred from each pattern's `:param` segments. Write it
   * to a `.d.ts` so `urlFor(name, params)` is type-checked. Returns the source;
   * the caller decides where to persist it.
   */
  generateTypes(): string {
    if (this.#indexDirty) this.#buildIndex()
    const names = [...this.#nameIndex.keys()].sort()
    if (names.length === 0) {
      return 'export type RouteName = never\nexport interface RouteParams {}\n'
    }
    const union = names.map((name) => `  | ${JSON.stringify(name)}`).join('\n')
    const entries = names.map((name) => {
      const pattern = this.#nameIndex.get(name)?.path ?? ''
      const params = [...pattern.matchAll(/:([A-Za-z_]\w*)(\??)/g)]
      const shape =
        params.length === 0
          ? 'Record<string, never>'
          : `{ ${params.map((m) => `${JSON.stringify(m[1])}${m[2] === '?' ? '?' : ''}: string`).join('; ')} }`
      return `  ${JSON.stringify(name)}: ${shape}`
    })
    return `export type RouteName =\n${union}\n\nexport interface RouteParams {\n${entries.join('\n')}\n}\n`
  }

  // ─── Lookup ───────────────────────────────────────────────

  /**
   * Find a registered route by name or exact pattern (AdonisJS `router.find`).
   * Returns null when nothing matches. Soft-deleted routes are ignored.
   */
  find(identifier: string): RouteDefinition | null {
    if (this.#indexDirty) this.#buildIndex()
    const byName = this.#nameIndex.get(identifier)
    if (byName) return byName
    return this.#routes.find((route) => !route.deleted && route.path === identifier) ?? null
  }

  /** Like {@link find} but throws when the route is absent (AdonisJS `findOrFail`). */
  findOrFail(identifier: string): RouteDefinition {
    const route = this.find(identifier)
    if (!route) throw new Error(`Cannot find route for '${identifier}'`)
    return route
  }

  /** True when a route with the given name or pattern exists (AdonisJS `router.has`). */
  has(identifier: string): boolean {
    return this.find(identifier) !== null
  }

  // ─── Accessors ────────────────────────────────────────────

  /** Get all registered (non-deleted) routes (for OpenAPI generation, introspection). */
  getRoutes(): RouteDefinition[] {
    return this.#routes.filter((route) => !route.deleted)
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
    this.#controllers.clear()
    this.#globalMatchers = {}
    this.#indexDirty = true
  }

  get routeCount(): number {
    return this.#routes.length
  }

  // ─── Internals ────────────────────────────────────────────

  #createDefinition(method: string, path: string, handler: RouteHandler): RouteDefinition {
    return makeDefinition(method, path, handler)
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

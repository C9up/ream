/**
 * Fluent Router — define REST routes with chaining.
 *
 * Routes register immediately. Builder methods mutate the registered route in-place.
 * No microtasks, no race conditions.
 *
 * @implements FR24, FR25, FR26, FR27, FR28
 */

import type { Context } from '../Context.js'

export type RouteHandler = (ctx: Context) => Promise<void> | void

export interface MatchResult {
  route: RouteDefinition
  params: Record<string, string>
}

export interface RouteDefinition {
  method: string
  path: string
  handler: RouteHandler
  middleware: string[]
  guards: string[]
  roles: string[]
  permissions: string[]
  validators: string[]
  version?: string
  deprecates?: { version: string; sunset?: string }
}

/** Fluent route builder — mutates the already-registered route definition. */
export class RouteBuilder {
  private route: RouteDefinition

  constructor(route: RouteDefinition) {
    this.route = route
  }

  middleware(...names: string[]): this {
    this.route.middleware.push(...names)
    return this
  }

  guard(...guards: string[]): this {
    this.route.guards.push(...guards)
    return this
  }

  role(...roles: string[]): this {
    this.route.roles.push(...roles)
    return this
  }

  permission(...permissions: string[]): this {
    this.route.permissions.push(...permissions)
    return this
  }

  validate(validator: string): this {
    this.route.validators.push(validator)
    return this
  }

  version(v: string): this {
    this.route.version = v
    return this
  }

  deprecates(version: string, options?: { sunset?: string }): this {
    this.route.deprecates = { version, sunset: options?.sunset }
    return this
  }
}

/** Main Router. */
export class Router {
  private routes: RouteDefinition[] = []

  /** Register a route with any HTTP method. */
  route(method: string, path: string, handler: RouteHandler): RouteBuilder {
    const def: RouteDefinition = {
      method: method.toUpperCase(),
      path,
      handler,
      middleware: [],
      guards: [],
      roles: [],
      permissions: [],
      validators: [],
    }
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

  /**
   * Create a route group with shared prefix, middleware, and guards.
   * Fully synchronous.
   */
  group(
    config: { prefix?: string; middleware?: string[]; guards?: string[]; roles?: string[]; permissions?: string[] },
    callback: (router: Router) => void,
  ): void {
    const childRouter = new Router()
    callback(childRouter)

    for (const route of childRouter.routes) {
      this.routes.push({
        ...route,
        path: (config.prefix ?? '') + route.path,
        middleware: [...(config.middleware ?? []), ...route.middleware],
        guards: [...(config.guards ?? []), ...route.guards],
        roles: [...(config.roles ?? []), ...route.roles],
        permissions: [...(config.permissions ?? []), ...route.permissions],
        validators: [...route.validators],
      })
    }
  }

  /** Find a matching route, extracting :param values. */
  match(method: string, path: string): MatchResult | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue
      const params = matchPath(route.path, path)
      if (params !== null) {
        return { route, params }
      }
    }
    return undefined
  }

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
}

/** Match path pattern against actual path, extracting params. Returns null on no match. */
function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const actualParts = actual.split('/')

  if (patternParts.length !== actualParts.length) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]
    if (part.startsWith(':')) {
      params[part.substring(1)] = actualParts[i]
    } else if (part !== actualParts[i]) {
      return null
    }
  }

  return params
}

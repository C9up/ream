/**
 * `OpenApiProvider` — serves an auto-generated OpenAPI 3.1 spec + Swagger UI.
 *
 * `start()` mounts two routes, `GET /api-docs` (JSON) and `GET /docs` (Swagger
 * UI). The spec is generated lazily, on the first request, from the router's
 * registered routes — so every route registered while the application starts
 * up is included (the spec must NOT be generated eagerly, before the other
 * providers and the preloads have registered their routes).
 *
 * The document lists every route with its guards, the controller and method
 * behind it and the schema of its validated body: an inventory of the API.
 * So it is off in production unless `enabled: true` says otherwise, and it is
 * served by routes rather than by a server middleware: the application's own
 * server middleware (an auth wall, CORS, a rate limiter) runs before it, and
 * `guards` / `middleware` protect it like any route.
 *
 * @implements Story 24.4
 */

import { currentNodeEnv } from '../env/nodeEnv.js'
import { E_EMPTY_GATE_REQUIREMENT } from '../errors/codes.js'
import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareFunction } from '../middleware/Pipeline.js'
import type { AppContext } from '../Provider.js'
import { Provider } from '../Provider.js'
import type { RouteBuilder, Router } from '../router/Router.js'
import { OpenApiGenerator } from './OpenApiGenerator.js'
import { OpenApiMiddleware } from './OpenApiMiddleware.js'

export interface OpenApiDocsConfig {
  /**
   * Serve the docs endpoints. Default: on, except in production
   * (`NODE_ENV=production`), where the document is an inventory of the API
   * the provider cannot know is public. Set `true` to serve it there too —
   * behind `guards` or `middleware`.
   */
  enabled?: boolean
  /** Spec `info.title`. Default `'API'`. */
  title?: string
  /** Spec `info.version`. Default `'1.0.0'`. */
  version?: string
  /** Path serving the JSON spec. Default `/api-docs`. */
  specPath?: string
  /** Path serving the Swagger UI. Default `/docs`. */
  docsPath?: string
  /**
   * Guards a request to either path must be authenticated by (the routes'
   * `.guard(...)`). An empty list is refused with `E_EMPTY_GATE_REQUIREMENT`:
   * leave the key out for no guard.
   */
  guards?: string[]
  /**
   * Middleware run before the document is served: names registered with
   * `router.named()` (the routes' `.middleware(...)`) or functions (`.use(...)`).
   */
  middleware?: Array<string | MiddlewareFunction>
}
export interface OpenApiProviderOptions {
  /** Override the generator — used by tests. */
  generator?: OpenApiGenerator
}

export class OpenApiProvider extends Provider {
  readonly #override?: OpenApiGenerator

  constructor(app: AppContext, options: OpenApiProviderOptions = {}) {
    super(app)
    this.#override = options.generator
  }

  /**
   * Routes and server middleware go in `start`, not `boot`.
   *
   * Upstream documents that phase for exactly this, and the order is what makes
   * it matter: providers boot, then providers START, then the preloads run —
   * and the preloads are where an application writes its own routes and kernel.
   * Mounted in `boot`, a framework route landed ahead of every application
   * route, so an overlapping path was answered by the framework rather than by
   * the app that meant to override it.
   */
  override async start(): Promise<void> {
    const config = this.app.config.get<OpenApiDocsConfig>('openapi') ?? {}
    if (!(config.enabled ?? currentNodeEnv() !== 'production')) return
    if (config.guards !== undefined && config.guards.length === 0) {
      throw new E_EMPTY_GATE_REQUIREMENT(['config/openapi.ts', 'guards: []'])
    }

    const generator = this.#override ?? (await this.#buildGenerator(config))
    const specPath = config.specPath ?? '/api-docs'
    const docsPath = config.docsPath ?? '/docs'
    const docs = new OpenApiMiddleware({
      specPath,
      docsPath,
      // The document describes the application's API, not its own two routes.
      spec: () => withoutRoutes(generator.generate(), [specPath, docsPath]),
    })
    const router = await this.app.container.make<Router>('router')
    // Routes, not a server middleware: a provider starts before the preloads,
    // so a server middleware mounted here ran ahead of the application's own
    // kernel, and no route guard could reach it.
    for (const route of [
      router.get(specPath, (ctx: HttpContext) => docs.sendSpec(ctx)),
      router.get(docsPath, (ctx: HttpContext) => docs.sendDocs(ctx)),
    ]) {
      protect(route, config)
    }
  }

  async #buildGenerator(config: OpenApiDocsConfig): Promise<OpenApiGenerator> {
    const router = await this.app.container.make<Router>('router')
    const generator = new OpenApiGenerator(router, {
      title: config.title ?? 'API',
      version: config.version ?? '1.0.0',
    })
    // The routes already name their validators; ask each one to describe
    // itself instead of making the app repeat the shape by hand.
    await generator.hydrateSchemas((token) => this.app.container.make<unknown>(token))
    return generator
  }
}

/** Apply the configured guards and middleware to one docs route. */
function protect(route: RouteBuilder, config: OpenApiDocsConfig): void {
  if (config.guards !== undefined) route.guard(...config.guards)
  for (const entry of config.middleware ?? []) {
    if (typeof entry === 'string') route.middleware(entry)
    else route.use(entry)
  }
}

type OpenApiSpec = ReturnType<OpenApiGenerator['generate']>

/** The spec without the `GET` operations of the given paths. */
function withoutRoutes(spec: OpenApiSpec, paths: string[]): OpenApiSpec {
  for (const path of paths) {
    const item = spec.paths[path]
    if (item === undefined) continue
    delete item.get
    if (Object.keys(item).length === 0) delete spec.paths[path]
  }
  return spec
}

// Default export so reamrc's provider loader can `() => import('@c9up/ream/<feature>/provider')` (resolves to { default }), matching events/rpc. Named export above stays.
export default OpenApiProvider

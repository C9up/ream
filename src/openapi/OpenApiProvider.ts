/**
 * `OpenApiProvider` — serves an auto-generated OpenAPI 3.1 spec + Swagger UI.
 *
 * `boot()` mounts a global middleware that, on the first GET to `/api-docs`
 * (JSON) or `/docs` (Swagger UI), lazily generates the spec from the router's
 * registered routes — so every route registered during boot/start is included
 * (the spec must NOT be generated eagerly at boot, before other providers have
 * registered their routes). Opt-out via `config.openapi.enabled = false`.
 *
 * @implements Story 24.4
 */

import type { AppContext } from '../Provider.js'
import { Provider } from '../Provider.js'
import type { Router } from '../router/Router.js'
import type { Server } from '../server/Server.js'
import { OpenApiGenerator } from './OpenApiGenerator.js'
import { OpenApiMiddleware } from './OpenApiMiddleware.js'

export interface OpenApiDocsConfig {
  /** Disable the docs endpoints entirely. Default: enabled. */
  enabled?: boolean
  /** Spec `info.title`. Default `'API'`. */
  title?: string
  /** Spec `info.version`. Default `'1.0.0'`. */
  version?: string
  /** Path serving the JSON spec. Default `/api-docs`. */
  specPath?: string
  /** Path serving the Swagger UI. Default `/docs`. */
  docsPath?: string
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

  override async boot(): Promise<void> {
    const config = this.app.config.get<OpenApiDocsConfig>('openapi') ?? {}
    if (config.enabled === false) return

    const generator = this.#override ?? this.#buildGenerator(config)
    const server = this.app.container.make<Server>('server')
    const middleware = new OpenApiMiddleware({
      specPath: config.specPath,
      docsPath: config.docsPath,
      spec: () => generator.generate(),
    })
    server.use([(ctx, next) => middleware.handle(ctx, next)])
  }

  #buildGenerator(config: OpenApiDocsConfig): OpenApiGenerator {
    const router = this.app.container.make<Router>('router')
    return new OpenApiGenerator(router, {
      title: config.title ?? 'API',
      version: config.version ?? '1.0.0',
    })
  }
}

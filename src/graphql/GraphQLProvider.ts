/**
 * `GraphQLProvider` — wires the GraphQL gateway into the Ream pipeline.
 *
 * Opt-in: does nothing unless `config.graphql.schemaPath` is set (or an engine
 * is injected for tests). When configured:
 *   - `register()` — construct a `GraphQLEngine` from `config.graphql`, give it
 *     the IoC container for resolver DI, and bind it under the `'graphql'` token:
 *
 *       const gql = app.container.make<GraphQLEngine>('graphql')
 *       gql.resolver('Query', 'tasks', TaskResolver, 'tasks')
 *
 *   - `boot()` — mount the engine at `engine.path` (default `/graphql`) for both
 *     GET (playground/introspection) and POST (queries).
 *
 * @implements Story 24.5
 */

import type { AppContext } from '../Provider.js'
import { Provider } from '../Provider.js'
import type { Router } from '../router/Router.js'
import { type GraphQLConfig, GraphQLEngine } from './GraphQLEngine.js'

export interface GraphQLProviderOptions {
  /** Override the `GraphQLEngine` instance — used by tests. */
  engine?: GraphQLEngine
}

export class GraphQLProvider extends Provider {
  #engine?: GraphQLEngine

  constructor(app: AppContext, options: GraphQLProviderOptions = {}) {
    super(app)
    this.#engine = options.engine
  }

  /** The wired engine, or undefined when GraphQL is not configured. */
  get engine(): GraphQLEngine | undefined {
    return this.#engine
  }

  override register(): void {
    const config = this.app.config.get<GraphQLConfig>('graphql')
    const engine = this.#engine ?? (config?.schemaPath ? new GraphQLEngine(config) : undefined)
    if (!engine) return // GraphQL not configured — opt-out.
    engine.useContainer(this.app.container)
    this.#engine = engine
    this.app.container.singleton('graphql', () => engine)
  }

  override async boot(): Promise<void> {
    const engine = this.#engine
    if (!engine) return
    const router = this.app.container.make<Router>('router')
    // GraphQLEngine.handle() serves the playground on GET and executes queries
    // on POST, so mount the same path for both verbs.
    router.get(engine.path, (ctx) => engine.handle(ctx))
    router.post(engine.path, (ctx) => engine.handle(ctx))
  }
}

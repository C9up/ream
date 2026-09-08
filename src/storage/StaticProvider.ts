/**
 * `StaticProvider` — serves static files from a directory.
 *
 * Opt-in: does nothing unless `config.static.root` is set (or a middleware is
 * injected for tests). When configured, `start()` mounts a global
 * `StaticMiddleware` (path-traversal + symlink-escape guarded) that serves
 * matching requests and falls through (`next()`) otherwise.
 *
 *   // config/static.ts
 *   export default { root: 'public', prefix: '/static' }
 *
 * @implements MISS-25
 */

import type { AppContext } from '../Provider.js'
import { Provider } from '../Provider.js'
import type { Server } from '../server/Server.js'
import { type StaticConfig, StaticMiddleware } from './StaticMiddleware.js'

export interface StaticProviderOptions {
  /** Override the `StaticMiddleware` instance — used by tests. */
  middleware?: StaticMiddleware
}

export class StaticProvider extends Provider {
  readonly #override?: StaticMiddleware

  constructor(app: AppContext, options: StaticProviderOptions = {}) {
    super(app)
    this.#override = options.middleware
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
    const config = this.app.config.get<StaticConfig>('static')
    const middleware = this.#override ?? (config?.root ? new StaticMiddleware(config) : undefined)
    if (!middleware) return // not configured — opt-out
    const server = await this.app.container.make<Server>('server')
    server.use([(ctx, next) => middleware.handle(ctx, next)])
  }
}

// Default export so reamrc's provider loader can `() => import('@c9up/ream/storage/provider')` (resolves to { default }), matching events/rpc. Named export above stays.
export default StaticProvider

/**
 * `RpcProvider` — wires a JSON-RPC 2.0 endpoint into the Ream pipeline.
 *
 *   - `register()` — bind a shared `RpcRouter` (with the IoC container, so
 *     `namespace()` controllers are DI-resolved) under the token `'rpc'`. Apps
 *     register methods by resolving it:
 *
 *       const rpc = app.container.make<RpcRouter>('rpc')
 *       rpc.method('task.validate', handler).guard('jwt')
 *       rpc.namespace('user', UserController)
 *
 *   - `boot()` — mount `POST <config.rpc.path ?? '/rpc'>` on the core router,
 *     dispatching every request body (single or batch) to `RpcRouter.handle()`.
 *
 * @implements Story 24.1, 24.2
 */

import type { HttpContext } from '../http/HttpContext.js'
import type { AppContext } from '../Provider.js'
import { Provider } from '../Provider.js'
import type { Router } from '../router/Router.js'
import { RpcRouter } from './RpcRouter.js'

export interface RpcProviderOptions {
  /** Override the `RpcRouter` instance — used by tests. */
  router?: RpcRouter
}

export interface RpcConfig {
  /** HTTP path the JSON-RPC endpoint is mounted at. Default `/rpc`. */
  path?: string
}

export class RpcProvider extends Provider {
  readonly rpc: RpcRouter

  constructor(app: AppContext, options: RpcProviderOptions = {}) {
    super(app)
    this.rpc = options.router ?? new RpcRouter()
  }

  override register(): void {
    this.rpc.useContainer(this.app.container)
    this.app.container.singleton('rpc', () => this.rpc)
  }

  override async boot(): Promise<void> {
    const path = this.app.config.get<RpcConfig>('rpc')?.path ?? '/rpc'
    const router = this.app.container.make<Router>('router')
    // RpcRouter.handle() reads the registered methods at request time, so the
    // mount can happen before apps finish registering methods.
    router.post(path, (ctx: HttpContext) => this.rpc.handle(ctx))
  }
}

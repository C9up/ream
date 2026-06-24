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

import { ReamError } from '../errors/ReamError.js'
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
    const container = this.app.container
    if (container.has('rpc')) {
      if (container.resolve('rpc') === this.rpc) return // re-register is idempotent
      throw new ReamError(
        'RPC_PROVIDER_ALREADY_REGISTERED',
        "Container token 'rpc' is already bound to a different instance",
        {
          hint: 'Only one RpcProvider can own the rpc binding. Remove the duplicate provider from your reamrc.ts.',
        },
      )
    }
    this.rpc.useContainer(container)
    container.singleton('rpc', () => this.rpc)
  }

  override async boot(): Promise<void> {
    const path = this.app.config.get<RpcConfig>('rpc')?.path ?? '/rpc'
    const router = this.app.container.make<Router>('router')
    // RpcRouter.handle() reads the registered methods at request time, so the
    // mount can happen before apps finish registering methods.
    router.post(path, (ctx: HttpContext) => this.rpc.handle(ctx))
  }
}

// Also expose as the default export so reamrc's provider loader can do
// `() => import('@c9up/ream/rpc/provider')` (which resolves to `{ default }`),
// matching EventsProvider. The named `export class RpcProvider` above stays for
// `import { RpcProvider }`.
export default RpcProvider

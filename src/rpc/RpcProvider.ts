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
  /**
   * Guards applied to the `/rpc` route itself (e.g. `['jwt']`), so warden
   * authenticates the endpoint at the edge and populates `ctx.auth` for every
   * call — which per-method `.guard()` / `authorizeRpc()` then read. Without
   * this, the inline-mounted route carries no guard metadata, so warden treats
   * it as public and never populates `ctx.auth` (every guarded method 401s).
   */
  guards?: string[]
}

export class RpcProvider extends Provider {
  readonly rpc: RpcRouter
  #registered = false

  constructor(app: AppContext, options: RpcProviderOptions = {}) {
    super(app)
    this.rpc = options.router ?? new RpcRouter()
  }

  override register(): void {
    const container = this.app.container
    if (container.has('rpc')) {
      // Idempotent re-register: tracked with a flag rather than
      // `container.resolve('rpc')` because resolution is now async.
      if (this.#registered) return
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
    this.#registered = true
  }

  override async boot(): Promise<void> {
    const config = this.app.config.get<RpcConfig>('rpc')
    const path = config?.path ?? '/rpc'
    const router = await this.app.container.make<Router>('router')
    // RpcRouter.handle() reads the registered methods at request time, so the
    // mount can happen before apps finish registering methods.
    const route = router.post(path, (ctx: HttpContext) => this.rpc.handle(ctx))
    // Apply route-level guards (e.g. ['jwt']) so warden authenticates the
    // endpoint at the edge and populates ctx.auth — the inline route has no
    // decorator metadata otherwise.
    const guards = config?.guards ?? []
    if (guards.length > 0) route.guard(...guards)
  }
}

// Also expose as the default export so reamrc's provider loader can do
// `() => import('@c9up/ream/rpc/provider')` (which resolves to `{ default }`),
// matching EventsProvider. The named `export class RpcProvider` above stays for
// `import { RpcProvider }`.
export default RpcProvider

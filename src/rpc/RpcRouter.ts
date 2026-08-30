/**
 * JSON-RPC 2.0 Router — dispatches RPC method calls to handlers.
 *
 * Same middleware/guard/validate pipeline as REST routes.
 *
 * Usage:
 *   rpc.method('task.validate', handler).guard('jwt').role('cs_member')
 *   rpc.namespace('task', TaskController)  // every public method, DI-resolved per call
 *   rpc.group({ guard: 'jwt' }, (r) => { r.method('user.find', handler) })
 *
 * @implements MISS-27
 */

import {
  buildSuccess,
  isNotification,
  isRpcShapedError,
  parseRequest as parseRpcRequest,
  buildError as rpcError,
} from '@c9up/comet'
import { currentNodeEnv } from '../env/nodeEnv.js'
import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareRegistry, RuntimeValidator } from '../middleware/Pipeline.js'
import { composeMiddleware, runValidator } from '../middleware/Pipeline.js'

export type RpcHandler = (ctx: HttpContext, params: unknown) => Promise<unknown> | unknown

/**
 * Subset of the IoC container RpcRouter needs: resolve `namespace()` controllers,
 * the shared `'middleware'` registry, and `validator:<name>` schemas.
 */
interface RpcContainer {
  make<T>(target: new (...args: unknown[]) => T): Promise<T>
  resolve<T>(token: string): Promise<T>
  has(token: string): boolean
}

export interface RpcMethodDefinition {
  name: string
  handler: RpcHandler
  guards: string[]
  roles: string[]
  permissions: string[]
  middleware: string[]
  validator?: string
}

export class RpcMethodBuilder {
  #def: RpcMethodDefinition

  constructor(def: RpcMethodDefinition) {
    this.#def = def
  }

  guard(...guards: string[]): this {
    this.#def.guards.push(...guards)
    return this
  }

  role(...roles: string[]): this {
    this.#def.roles.push(...roles)
    return this
  }

  permission(...permissions: string[]): this {
    this.#def.permissions.push(...permissions)
    return this
  }

  validate(validator: string): this {
    this.#def.validator = validator
    return this
  }

  middleware(...names: string[]): this {
    this.#def.middleware.push(...names)
    return this
  }
}

/**
 * Unwrap the `{ _body: [...] }` envelope `request.body()` puts around a
 * top-level JSON array (it only treats plain objects as the body verbatim). A
 * JSON-RPC batch arrives this way; a single request is a plain object and is
 * returned unchanged.
 */
function unwrapBatchBody(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && '_body' in value) {
    const inner = value._body
    if (Array.isArray(inner)) return inner
  }
  return value
}

/**
 * Enforce the method's guards/roles/permissions against the request auth state.
 * Returns the JSON-RPC error code+message to reject with, or undefined when the
 * caller is authorized.
 */
function checkRpcAuthorization(
  ctx: HttpContext,
  def: RpcMethodDefinition,
): { code: number; message: string } | undefined {
  const needsAuth = def.guards.length > 0 || def.roles.length > 0 || def.permissions.length > 0
  if (needsAuth && !ctx.auth?.isAuthenticated) {
    return { code: -32003, message: 'Unauthorized' }
  }
  if (def.roles.length > 0) {
    // Warden nests roles/permissions under ctx.auth.user — mirror the HTTP path
    // (Pipeline.ts createGuardMiddleware) so RPC role gates aren't fail-closed-dead.
    const userRoles = ctx.auth?.roles ?? ctx.auth?.user?.roles ?? []
    if (!def.roles.some((r: string) => userRoles.includes(r))) {
      return { code: -32003, message: 'Insufficient role' }
    }
  }
  if (def.permissions.length > 0) {
    const userPerms = ctx.auth?.permissions ?? ctx.auth?.user?.permissions ?? []
    if (!def.permissions.every((p: string) => userPerms.includes(p))) {
      return { code: -32003, message: 'Insufficient permissions' }
    }
  }
  return undefined
}

export class RpcRouter {
  #methods: Map<string, RpcMethodDefinition> = new Map()
  #groupConfig: { guards: string[]; roles: string[]; middleware: string[] } | null = null
  #container?: RpcContainer

  /**
   * Set the IoC container used to resolve `namespace()` controllers — mirrors
   * `GraphQLEngine.useContainer()` so RPC and GraphQL resolve class handlers the
   * same way (fresh DI per call). Without a container, controllers fall back to
   * `new Controller()`.
   */
  useContainer(container: RpcContainer): void {
    this.#container = container
  }

  /** Register an RPC method. */
  method(name: string, handler: RpcHandler): RpcMethodBuilder {
    const def: RpcMethodDefinition = {
      name,
      handler,
      guards: [...(this.#groupConfig?.guards ?? [])],
      roles: [...(this.#groupConfig?.roles ?? [])],
      permissions: [],
      middleware: [...(this.#groupConfig?.middleware ?? [])],
    }
    this.#methods.set(name, def)
    return new RpcMethodBuilder(def)
  }

  /** Register methods from a controller — auto-registers all public methods. */
  namespace(
    prefix: string,
    controller: new (...args: unknown[]) => Record<string, (...args: unknown[]) => unknown>,
  ): void {
    const proto = controller.prototype
    const methods = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor' && typeof proto[m] === 'function',
    )
    for (const methodName of methods) {
      this.method(`${prefix}.${methodName}`, async (ctx, params) => {
        // Resolve through the container on every call (fresh DI per request,
        // like GraphQLEngine), falling back to a bare `new` when unset.
        const instance = this.#container ? await this.#container.make(controller) : new controller()
        return instance[methodName](ctx, params)
      })
    }
  }

  /** Group methods with shared guards/middleware. */
  group(
    config: { guard?: string; guards?: string[]; middleware?: string[] },
    callback: (rpc: RpcRouter) => void,
  ): void {
    const prevConfig = this.#groupConfig
    this.#groupConfig = {
      guards: [...(config.guards ?? []), ...(config.guard ? [config.guard] : [])],
      roles: [],
      middleware: config.middleware ?? [],
    }
    // try/finally so a throwing callback can't leave #groupConfig stuck at the
    // group's value and leak its guards/middleware onto sibling registrations.
    try {
      callback(this)
    } finally {
      this.#groupConfig = prevConfig
    }
  }

  /** Handle an incoming JSON-RPC request. */
  async handle(ctx: HttpContext): Promise<void> {
    // `request.body()` wraps a top-level JSON array — a JSON-RPC batch — as its
    // non-object envelope `{ _body: [...] }`. Unwrap it so batch detection works;
    // a single request is a plain object and passes through untouched.
    const body = unwrapBatchBody(ctx.request.body())

    // Batch support (max 50 to prevent DoS)
    if (Array.isArray(body)) {
      if (body.length > 50) {
        ctx.response.status(400).json(rpcError(-32600, 'Batch too large (max 50)', null))
        return
      }
      // Note: batch items share the same ctx (auth state). Each is processed sequentially.
      // Notifications still run (side-effects) but their result is omitted from
      // the reply per JSON-RPC §4.1.
      const results: unknown[] = []
      for (const req of body) {
        const r = await this.#processOne(ctx, req)
        if (!isNotification(req)) results.push(r)
      }
      // An all-notification batch produces no response body (spec: no reply).
      if (results.length === 0) {
        ctx.response.status(204).send('')
        return
      }
      ctx.response.status(200).json(results)
      return
    }

    const result = await this.#processOne(ctx, body)
    // A notification runs for side-effects but MUST NOT receive a reply.
    if (isNotification(body)) {
      ctx.response.status(204).send('')
      return
    }
    ctx.response.status(200).json(result)
  }

  /**
   * Run the method's declared named middleware (resolved from the shared
   * `'middleware'` registry) onion-style before the handler. Guards/auth
   * middleware deny by THROWING — #processOne maps the throw to a JSON-RPC
   * error. An unknown middleware name is a hard error, never a silent skip.
   * (RPC shares one ctx per batch, so response-writing/short-circuit middleware
   * are unsupported — deny by throwing.)
   */
  async #runMiddleware(ctx: HttpContext, names: string[]): Promise<void> {
    const registry = this.#container?.has('middleware')
      ? await this.#container.resolve<MiddlewareRegistry>('middleware')
      : undefined
    if (!registry) {
      throw new Error(
        `[E_MIDDLEWARE_NOT_FOUND] RPC middleware [${names.join(', ')}] is declared but no middleware registry is wired into the RpcRouter.`,
      )
    }
    const fns = names.map((name) => {
      const mw = registry.get(name)
      if (!mw) {
        throw new Error(`[E_MIDDLEWARE_NOT_FOUND] Named middleware '${name}' is not registered.`)
      }
      return mw
    })
    await composeMiddleware(fns)(ctx, async () => {})
  }

  async #processOne(ctx: HttpContext, request: unknown): Promise<unknown> {
    const parsed = parseRpcRequest(request)
    if (!parsed.ok) return parsed.response
    const { method, params, id } = parsed

    const def = this.#methods.get(method)
    if (!def) return rpcError(-32601, 'Method not found', id)

    try {
      const denied = checkRpcAuthorization(ctx, def)
      if (denied) return rpcError(denied.code, denied.message, id)

      // Run declared named middleware (e.g. guards) — they throw to deny, mapped
      // to a JSON-RPC error by the catch below.
      if (def.middleware.length > 0) {
        await this.#runMiddleware(ctx, def.middleware)
      }

      // Run the declared validator against params. A declared-but-unregistered
      // validator is a hard error — never silently skip validation.
      let effectiveParams = params
      if (def.validator) {
        const token = `validator:${def.validator}`
        if (!this.#container?.has(token)) {
          return rpcError(
            -32603,
            `Validator '${def.validator}' is not registered (bind container.singleton('${token}', () => schema)).`,
            id,
          )
        }
        const validator = await this.#container.resolve<RuntimeValidator>(token)
        // `runValidator` picks the async result form first — the synchronous
        // one cannot run `unique` / `exists` and throws outright when the schema
        // carries them.
        let outcome: Awaited<ReturnType<typeof runValidator>>
        try {
          outcome = await runValidator(validator, params)
        } catch (err) {
          return rpcError(
            -32603,
            err instanceof TypeError
              ? `Validator '${def.validator}' exposes no usable validate method.`
              : `Validator '${def.validator}' failed: ${err instanceof Error ? err.message : String(err)}`,
            id,
          )
        }
        if (!outcome.valid) return rpcError(-32602, 'Invalid params', id, outcome.errors)
        effectiveParams = outcome.data ?? params
      }

      const result = await def.handler(ctx, effectiveParams)
      return buildSuccess(result, id)
    } catch (err) {
      // Honor a JSON-RPC-shaped error thrown by a handler (one carrying a numeric
      // `code`), so handlers can return domain errors — -32004 not-found, -32009
      // conflict, etc. — instead of every throw collapsing to -32603.
      if (isRpcShapedError(err)) {
        const message = typeof err.message === 'string' ? err.message : 'RPC error'
        return rpcError(err.code, message, id, err.data)
      }
      // Otherwise don't leak internal error details to the caller.
      const isDev = currentNodeEnv() !== 'production'
      const message = isDev && err instanceof Error ? err.message : 'Internal error'
      return rpcError(-32603, message, id)
    }
  }

  /** Get all registered method names. */
  getMethods(): string[] {
    return [...this.#methods.keys()]
  }

  /** Get method definition for introspection. */
  getMethod(name: string): RpcMethodDefinition | undefined {
    return this.#methods.get(name)
  }
}

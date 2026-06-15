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

import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareRegistry, RuntimeValidator } from '../middleware/Pipeline.js'
import { compose } from '../middleware/Pipeline.js'

export type RpcHandler = (ctx: HttpContext, params: unknown) => Promise<unknown> | unknown

/**
 * Subset of the IoC container RpcRouter needs: resolve `namespace()` controllers,
 * the shared `'middleware'` registry, and `validator:<name>` schemas.
 */
interface RpcContainer {
  make<T>(target: new (...args: unknown[]) => T): T
  resolve<T>(token: string): T
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

interface RpcErrorResponse {
  jsonrpc: '2.0'
  error: { code: number; message: string; data?: unknown }
  id: unknown
}

/** Build a JSON-RPC 2.0 error envelope. */
function rpcError(code: number, message: string, id: unknown, data?: unknown): RpcErrorResponse {
  return {
    jsonrpc: '2.0',
    error: data === undefined ? { code, message } : { code, message, data },
    id,
  }
}

type ParsedRpcRequest =
  | { ok: true; method: string; params: unknown; id: unknown }
  | { ok: false; response: RpcErrorResponse }

/** Validate the JSON-RPC envelope and extract method/params/id. */
function parseRpcRequest(request: unknown): ParsedRpcRequest {
  if (!request || typeof request !== 'object') {
    return { ok: false, response: rpcError(-32600, 'Invalid Request', null) }
  }
  // request is narrowed to a non-null object by the typeof check above.
  const jsonrpc =
    'jsonrpc' in request && typeof request.jsonrpc === 'string' ? request.jsonrpc : undefined
  const method =
    'method' in request && typeof request.method === 'string' ? request.method : undefined
  const params = 'params' in request ? request.params : undefined
  const id = 'id' in request ? request.id : undefined
  if (jsonrpc !== '2.0' || !method) {
    return { ok: false, response: rpcError(-32600, 'Invalid Request', id ?? null) }
  }
  return { ok: true, method, params, id }
}

/**
 * A JSON-RPC notification is a well-formed request with NO `id` member. The spec
 * (§4.1) says the server MUST NOT reply to one — it still runs for side-effects.
 * A malformed object (no method / wrong version) is NOT a notification: it gets
 * an `id:null` error response since the server can't tell the client's intent.
 */
function isNotification(request: unknown): boolean {
  return (
    !!request &&
    typeof request === 'object' &&
    'jsonrpc' in request &&
    request.jsonrpc === '2.0' &&
    'method' in request &&
    typeof request.method === 'string' &&
    !('id' in request)
  )
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
  if (needsAuth && !ctx.auth?.authenticated) {
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
        const instance = this.#container ? this.#container.make(controller) : new controller()
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
    const body = ctx.request.body()

    // Batch support (max 50 to prevent DoS)
    if (Array.isArray(body)) {
      if (body.length > 50) {
        ctx.response.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Batch too large (max 50)' },
          id: null,
        })
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
      ? this.#container.resolve<MiddlewareRegistry>('middleware')
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
    await compose(fns)(ctx, async () => {})
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
        const outcome = this.#container.resolve<RuntimeValidator>(token).validate(params)
        if (!outcome.valid) return rpcError(-32602, 'Invalid params', id, outcome.errors)
        effectiveParams = outcome.data ?? params
      }

      const result = await def.handler(ctx, effectiveParams)
      return { jsonrpc: '2.0', result, id }
    } catch (err) {
      // Don't leak internal error details to caller
      const isDev = process.env.NODE_ENV !== 'production'
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

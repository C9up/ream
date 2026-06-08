/**
 * HttpKernel — bridges HyperServer NAPI with Router + Middleware Pipeline + ExceptionHandler.
 *
 * Request flow (like AdonisJS):
 * 1. Parse JSON from Rust NAPI
 * 2. Create HttpContext
 * 3. Onion pipeline: Server MW → Router MW → Route MW → Guards → Handler
 * 4. ExceptionHandler for any errors
 *
 * @implements FR21, FR22, FR23, FR24
 */

import type { Container } from './container/Container.js'
import type { Emitter } from './events/Emitter.js'
import { E_ROUTE_NOT_FOUND, ExceptionHandler } from './http/Exception.js'
import { HttpContext } from './http/HttpContext.js'
import type { MiddlewareFunction, MiddlewareRegistry } from './middleware/Pipeline.js'
import { compose } from './middleware/Pipeline.js'
import type { Router } from './router/Router.js'
import type { Dict } from './types/helpers.js'

export interface HttpKernelConfig {
  router: Router
  middleware: MiddlewareRegistry
  container?: Container
  exceptionHandler?: ExceptionHandler
  serverMiddleware?: MiddlewareFunction[]
  routerMiddleware?: MiddlewareFunction[]
  onError?: (error: unknown, ctx: HttpContext) => void
  debug?: boolean
  /**
   * Lazily-resolved streaming backend. The Ignitor wires this so that
   * `ctx.response.sse()` can register / push / close streams against the
   * Rust HyperServer registry. Returning `undefined` short-circuits the
   * SSE path with a clean error — used by mock servers in unit tests.
   */
  streamBackend?: () => import('./http/SseStream.js').StreamBackend | undefined
}

export interface HttpKernelResponse {
  status: number
  headers: Dict
  body: string
  /**
   * Streaming-response handle. Present when the route handler opened
   * an `SseStream` (`response.sse()`). The HyperServer NAPI matches
   * this id against its stream registry to keep the connection open
   * and feed the body from JS-pushed chunks.
   */
  streamId?: string
}

/**
 * Shape the kernel expects when called with an already-parsed object — the
 * NAPI bridge passes this directly to skip a JSON round-trip. The string
 * form is the legacy entrypoint kept for serverless / fixture use.
 */
export interface HttpKernelRequest {
  method: string
  path: string
  query: string
  headers: Dict
  body: string
  bodyEncoding?: 'utf8' | 'base64'
  remoteAddr?: string
}

export function createHttpKernel(
  config: HttpKernelConfig,
): (request: HttpKernelRequest) => Promise<HttpKernelResponse> {
  // Debug mode requires explicit opt-in — never leak stack traces by default
  const handler = config.exceptionHandler ?? new ExceptionHandler(config.debug === true)
  const serverMw = config.serverMiddleware ?? []
  const routerMw = config.routerMiddleware ?? []

  // Pipeline cache: compiled middleware chain per route key (PERF-7)
  // Cleared when router.clear() is called (hot-reload).
  const pipelineCache = new Map<string, { chain: MiddlewareFunction }>()

  // Hook into router clear for cache invalidation
  const origClear = config.router.clear.bind(config.router)
  config.router.clear = () => {
    origClear()
    pipelineCache.clear()
  }

  // Resolve the events emitter once, only when the app registered
  // `EventsProvider`. Lazy + cached: the binding may not exist yet at kernel
  // creation, and `has()` avoids loading the native bus for apps without events.
  let eventsEmitter: Emitter | undefined
  let eventsResolved = false
  const resolveEvents = (): Emitter | undefined => {
    if (!eventsResolved) {
      eventsResolved = true
      if (config.container?.has('events')) {
        eventsEmitter = config.container.resolve<Emitter>('events')
      }
    }
    return eventsEmitter
  }

  return async (reqData: HttpKernelRequest): Promise<HttpKernelResponse> => {
    // The Rust HyperServer hands the request as a typed JS object via napi
    // `to_js_value` (no JSON intermediate). Serverless adapters that pass a
    // JSON string must `JSON.parse` themselves before invoking the kernel.

    // 2. Correlation ID
    const CORR_ID_RE = /^[A-Za-z0-9\-_]{8,128}$/
    const rawCorrId = reqData.headers['x-request-id'] ?? reqData.headers['x-correlation-id'] ?? ''
    const correlationId = CORR_ID_RE.test(rawCorrId) ? rawCorrId : crypto.randomUUID()

    // 3. Match route (pass host for domain-based routing).
    // The Rust HyperServer lowercases every header name before handing
    // the request over (see crates/ream-http/src/request.rs — `headers`
    // is documented "lowercased"). Looking up `host` is therefore the
    // only correct key; the previous PascalCase fallback was dead code.
    const host = reqData.headers.host
    const match = config.router.match(reqData.method, reqData.path, host)
    const routeInfo = match
      ? {
          pattern: match.route.path,
          name: match.route.name,
          middleware: match.route.middleware,
          // Forward the controller class + method name onto the public
          // RouteInfo so middleware (Warden's @Guard, Photon's @Meta) can
          // read decorator metadata via Reflect. Absent for inline-arrow
          // route handlers — that's intentional, decorators only apply
          // to controller methods.
          controller: match.route.controller?.target.prototype as object | undefined,
          action: match.route.controller?.method,
        }
      : { pattern: '', middleware: [] }

    // 4. Create HttpContext
    const ctx = new HttpContext(correlationId, reqData, match?.params ?? {}, routeInfo)
    ctx.setRouteUrlResolver((name, params) => config.router.makeUrl(name, params))
    ctx.events = resolveEvents()
    // Wire the streaming backend so `ctx.response.sse()` can talk to
    // the HyperServer NAPI. Falls back silently when no backend is
    // available (mock server, websocket-only host) — the SSE helper
    // throws a clean error in that case.
    const backend = config.streamBackend?.()
    if (backend) {
      ctx.response.setStreamBackend(backend)
    }

    try {
      // 5. Build the FULL onion pipeline:
      //    Server MW → [route match check] → Router MW → Route named MW → Route inline MW → Guards → Handler
      const coreHandler: MiddlewareFunction = async (innerCtx) => {
        if (!match) {
          throw new E_ROUTE_NOT_FOUND(reqData.method, reqData.path)
        }

        // Cache key: method + path pattern (static per route definition)
        const cacheKey = `${match.route.method}:${match.route.path}`
        let cached = pipelineCache.get(cacheKey)

        if (!cached) {
          // Resolve handler (once per route)
          let routeHandler: (typeof match.route)['handler']
          if (match.route.controller) {
            routeHandler = createControllerHandler(match.route.controller, config.container)
          } else if (match.route.handler) {
            routeHandler = match.route.handler
          } else {
            throw new Error(
              `Route ${match.route.method} ${match.route.path} has neither controller nor handler`,
            )
          }

          // Merge route-level guards with controller method decorator metadata (once)
          let guards = [...match.route.guards]
          let roles = [...match.route.roles]
          let permissions = [...match.route.permissions]

          if (match.route.controller) {
            const meta = readControllerGuardMetadata(
              match.route.controller.target,
              match.route.controller.method,
            )
            guards = [...guards, ...meta.guards]
            roles = [...roles, ...meta.roles]
            permissions = [...permissions, ...meta.permissions]
          }

          // Compile pipeline once
          const chain = config.middleware.buildChain(
            match.route.middleware,
            [...routerMw, ...match.route.inlineMiddleware],
            async (c) => {
              await routeHandler(c)
            },
            { guards, roles, permissions },
          )

          cached = { chain }
          pipelineCache.set(cacheKey, cached)
        }

        // API versioning headers (per-request, cheap)
        if (match.route.version) {
          innerCtx.response.header('x-api-version', match.route.version)
        }
        if (match.route.deprecates) {
          innerCtx.response.header('deprecation', 'true')
          innerCtx.response.header('x-deprecated-version', match.route.deprecates.version)
          if (match.route.deprecates.sunset) {
            innerCtx.response.header('sunset', match.route.deprecates.sunset)
          }
        }

        await cached.chain(innerCtx, async () => {})
      }

      // Compose: server middleware wraps everything (onion)
      const fullPipeline = compose([...serverMw, coreHandler])
      await fullPipeline(ctx, async () => {})

      return serializeResponse(ctx)
    } catch (error) {
      // If the handler opened an SSE stream via `response.sse()` and
      // THEN threw, the reserved stream id is still on the response.
      // Tear it down before building the error response — otherwise
      // serializeResponse emits `streamId` next to an error body and
      // the HyperServer keeps feeding a dead stream slot forever.
      await ctx.response.abortStream()
      try {
        await handler.handle(error, ctx)
        await handler.report(error, ctx)
      } catch (handlerError) {
        console.error('ExceptionHandler failed:', handlerError)
        ctx.response
          .status(500)
          .json({ error: { code: 'E_HANDLER_FAILURE', message: 'An internal error occurred' } })
      }

      if (config.onError) {
        config.onError(error, ctx)
      }

      // Core domain event: a request raised an exception. Fire-and-forget
      // through the bus when events are wired (error path only — zero cost on
      // the happy path). Emitter isolates listener failures from the response.
      ctx.events?.emit('exception', {
        id: ctx.id,
        method: reqData.method,
        path: reqData.path,
        error: error instanceof Error ? error.message : String(error),
      })

      return serializeResponse(ctx)
    }
  }
}

function createControllerHandler(
  // biome-ignore lint/suspicious/noExplicitAny: see ControllerAction type — IoC resolves constructor params
  controller: { target: new (...args: any[]) => any; method: string },
  container?: Container,
): (ctx: HttpContext) => Promise<void> {
  return async (ctx: HttpContext) => {
    const instance = container ? container.make(controller.target) : new controller.target()
    const method = (instance as Record<string, (ctx: HttpContext) => Promise<void> | void>)[
      controller.method
    ]
    if (typeof method !== 'function') {
      throw new Error(
        `Controller method '${controller.method}' not found on ${controller.target.name}`,
      )
    }
    await method.call(instance, ctx)
  }
}

/**
 * Read @Guard, @Role, @Permission metadata from a controller method.
 * Returns empty arrays if no decorators are present.
 */
function readControllerGuardMetadata(
  target: new (...args: unknown[]) => unknown,
  method: string,
): { guards: string[]; roles: string[]; permissions: string[] } {
  try {
    const guards: string[] =
      Reflect.getMetadata(Symbol.for('warden:guard'), target.prototype, method) ?? []
    const roles: string[] =
      Reflect.getMetadata(Symbol.for('warden:role'), target.prototype, method) ?? []
    const permissions: string[] =
      Reflect.getMetadata(Symbol.for('warden:permission'), target.prototype, method) ?? []
    return { guards, roles, permissions }
  } catch {
    return { guards: [], roles: [], permissions: [] }
  }
}

function serializeResponse(ctx: HttpContext): HttpKernelResponse {
  const streamId = ctx.response.getStreamId()
  return {
    status: ctx.response.getStatus(),
    headers: ctx.response.getHeaders(),
    body: ctx.response.getBody(),
    ...(streamId !== undefined ? { streamId } : {}),
  }
}

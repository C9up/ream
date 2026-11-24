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

// Side-effect import: the route gate reads decorator metadata through
// `Reflect.getMetadata`, so it must not depend on something else having
// loaded the polyfill first.
import 'reflect-metadata'
import type { Container } from './container/Container.js'
import { debugHttp } from './debug.js'
import { hotReloadCount } from './dev/hmr.js'
import {
  E_APP_MISSING_DEFAULT_EXPORT,
  E_CONTROLLER_METHOD_NOT_FOUND,
  E_EMPTY_GATE_REQUIREMENT,
  E_MIDDLEWARE_NOT_FOUND,
  E_REAM_INTERNAL,
  E_VALIDATOR_NOT_FOUND,
} from './errors/codes.js'
import type { Emitter } from './events/Emitter.js'
import { E_ROUTE_NOT_FOUND, ExceptionHandler } from './http/Exception.js'
import { type ChildLoggerSource, HttpContext } from './http/HttpContext.js'
import { spoofedMethod } from './http/Request.js'
import type { CookieOptions } from './http/Response.js'
import { openWebSocket, type WebSocketHub } from './http/WebSocket.js'
import type {
  MiddlewareFunction,
  MiddlewareRegistry,
  RuntimeValidator,
} from './middleware/Pipeline.js'
import { composeMiddleware } from './middleware/Pipeline.js'
import { noteHandledError } from './profiler/handledError.js'
import type { AnyConstructor, RouteDefinition, Router } from './router/Router.js'
import type { CookieSigner } from './security/CookieSigner.js'
import type { SignedUrl } from './security/SignedUrl.js'
import type { Dict } from './types/helpers.js'

export interface HttpKernelConfig {
  router: Router
  middleware: MiddlewareRegistry
  container?: Container
  exceptionHandler?: ExceptionHandler
  serverMiddleware?: MiddlewareFunction[]
  /**
   * A `<script>` appended to every HTML response, dev only.
   *
   * Set by the Ignitor when the application runs in development; `undefined`
   * everywhere else, so a production response is byte-for-byte what the
   * handler produced. It lives here rather than in a middleware because this
   * is the one place every response passes through on its way out, whichever
   * route or error handler produced it.
   *
   * It is handed the whole context, not just the nonce: the debug toolbar
   * carries the profile token inline, and that token is only on the response
   * by the time the body is serialised.
   */
  devScript?: (ctx: HttpContext) => string
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
  /**
   * The server's WebSocket sockets, resolved lazily like the stream backend.
   * Without it a WebSocket route answers 501.
   */
  webSocketHub?: () => WebSocketHub | undefined
  /**
   * Honour a `_method` form field on POST (AdonisJS `http.allowMethodSpoofing`).
   *
   * OFF by default, as upstream. An HTML form cannot send PUT or DELETE, so an
   * app that relies on the workaround has to say so — otherwise any POST body
   * could rewrite itself into a DELETE.
   */
  allowMethodSpoofing?: boolean
  /**
   * Default callback name for `response.jsonp()` (AdonisJS
   * `http.jsonpCallbackName`). Falls back to `callback`.
   */
  jsonpCallbackName?: string
  /**
   * Attributes merged under every cookie a response writes (AdonisJS
   * `http.cookie`), already merged over the framework's defaults. Without it
   * the defaults apply: `maxAge: '2h'`, `path: '/'`, `httpOnly`, `secure`,
   * `sameSite: 'lax'`.
   */
  cookie?: CookieOptions
  /**
   * Ceiling on a buffered response body, in bytes. Default 100MB — the same the
   * Rust layer caps an incoming body at. Responses are not streamed yet, so the
   * body is held whole in memory; this is what stops a large one growing until
   * the process dies with no message.
   */
  maxResponseBytes?: number
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
  /**
   * With status 101: the socket a WebSocket route opened. The native server
   * completes the handshake and runs it.
   */
  websocketId?: string
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
  /** A WebSocket handshake the native server checked and passed on. */
  websocket?: boolean
}

/**
 * Every name a route gives `.middleware()` must be declared, with
 * `router.named()` or on the registry; otherwise `E_MIDDLEWARE_NOT_FOUND`,
 * naming the route.
 */
function assertNamedMiddlewareDeclared(router: Router, registry: MiddlewareRegistry): void {
  for (const route of router.getRoutes()) {
    for (const name of route.middleware) {
      if (registry.get(name) !== undefined || router.getNamedMiddleware(name) !== undefined) {
        continue
      }
      const known = new Set([...registry.names(), ...router.getNamedMiddlewareNames()])
      throw new E_MIDDLEWARE_NOT_FOUND([
        `Route ${route.method} ${route.path} uses the named middleware '${name}', which is not ` +
          `declared. Declare it with router.named({ ${name}: () => import('…') }). ` +
          `Registered: ${[...known].join(', ') || '(none)'}`,
      ])
    }
  }
}

export function createHttpKernel(
  config: HttpKernelConfig,
): (request: HttpKernelRequest) => Promise<HttpKernelResponse> {
  // Debug mode requires explicit opt-in — never leak stack traces by default
  const handler = config.exceptionHandler ?? new ExceptionHandler(config.debug === true)
  const serverMw = config.serverMiddleware ?? []
  const routerMw = config.routerMiddleware ?? []

  // Building the kernel is the application's boot: a route naming a middleware
  // nothing declares stops it here, as a misspelt `middleware.auht()` stops an
  // upstream application when its route file loads, rather than answering 500
  // on every request to that route. A route added after this point is still
  // refused when its pipeline is built.
  assertNamedMiddlewareDeclared(config.router, config.middleware)

  // Pipeline cache: compiled middleware chain per ROUTE OBJECT (PERF-7).
  // Keyed by route identity, not `method:path` — two routes sharing a path but
  // differing by `domain` would otherwise collide and serve the first-warmed
  // handler for both. WeakMap also makes hot-reload invalidation automatic:
  // router.clear() drops the route objects, their chains become unreachable
  // and are GC'd — no need to monkey-patch router.clear (which leaked a
  // wrapper chain when createHttpKernel ran more than once on one router).
  // `hotAt` is what makes hot reloading reach the router at all. A lazy
  // controller is promoted to a concrete one on first request and the whole
  // pipeline is cached per route — so once hot-hook swapped a module, both
  // still pointed at the class from before, the process kept serving it, and
  // the swap looked like it had not happened. Remembering when an entry was
  // built lets a later swap throw it away.
  //
  // In production this is a number compared against a constant zero: nothing
  // bumps the counter when `@c9up/ream/hot` was never loaded.
  const pipelineCache = new WeakMap<RouteDefinition, { chain: MiddlewareFunction; hotAt: number }>()

  // The hot-reload count each lazy controller was imported at, so a swap is
  // followed by a fresh import (see `importController`).
  const importedAt = new WeakMap<RouteDefinition, number>()

  /** Whether the route's lazy controller is still to import, or to import again after a hot swap. */
  const needsImport = (route: RouteDefinition): boolean =>
    route.lazyController !== undefined &&
    (route.controller === undefined || importedAt.get(route) !== hotReloadCount())

  /**
   * Promote a lazy or string controller (`[() => import('./x.js'), 'action']`,
   * `'XController.action'`) to a concrete one: imported once, then reused.
   *
   * It runs BEFORE the request's route info and context are built. Imported
   * from inside the handler, the controller was unknown to everything that
   * ran earlier on that first request: `ctx.route.controller` was empty, so a
   * middleware reading the action's decorators through it found none and
   * took the route for a public one.
   *
   * A failing import is handed back, not thrown: the request still gets its
   * context, and the error is raised where the handler would have run. The
   * route keeps no controller, so the next request imports again.
   */
  const importController = async (
    route: RouteDefinition,
  ): Promise<{ error: unknown } | undefined> => {
    const lazy = route.lazyController
    if (lazy === undefined) return undefined
    // After a hot swap the class promoted before is the stale one: dropped
    // first, so a failing re-import does not leave it in place.
    route.controller = undefined
    const hotAt = hotReloadCount()
    try {
      const mod = await lazy.loader()
      const target: unknown = mod.default
      if (typeof target !== 'function') {
        throw new E_APP_MISSING_DEFAULT_EXPORT([
          `The lazily imported controller of ${route.method} ${route.path} has no default export, or it is not a class.`,
        ])
      }
      route.controller = { target: mod.default, method: lazy.method }
      importedAt.set(route, hotAt)
      return undefined
    } catch (error) {
      return { error }
    }
  }

  // Resolve the events emitter once, only when the app registered
  // `EventsProvider`. Lazy + cached: the binding may not exist yet at kernel
  // creation, and `has()` avoids loading the native bus for apps without events.
  let eventsEmitter: Emitter | undefined
  let eventsResolved = false
  const resolveEvents = async (): Promise<Emitter | undefined> => {
    if (!eventsResolved) {
      eventsResolved = true
      if (config.container?.has('events')) {
        eventsEmitter = await config.container.resolve<Emitter>('events')
      }
    }
    return eventsEmitter
  }

  // APP_KEY-backed services + base logger, resolved once (the container is async
  // now, so they can't be resolved in the HttpContext constructor) and injected
  // per request via setters. Best-effort: absent bindings leave the feature off.
  let servicesResolved = false
  let encryption: CookieSigner | undefined
  let signedUrl: SignedUrl | undefined
  let baseLogger: ChildLoggerSource | undefined
  const resolveServices = async (): Promise<void> => {
    if (servicesResolved) return
    servicesResolved = true
    const c = config.container
    if (!c) return
    if (c.has('encryption')) encryption = await c.resolve<CookieSigner>('encryption')
    if (c.has('signedUrl')) signedUrl = await c.resolve<SignedUrl>('signedUrl')
    if (c.has('logger')) baseLogger = await c.resolve<ChildLoggerSource>('logger')
  }

  /**
   * Turn an error into the response, where it was thrown: the middleware
   * chain calls this at the layer an error leaves, as upstream's runner calls
   * its error handler, so every outer layer sees its `next()` resolve and runs
   * the code after it. Never throws: a failing handler answers 500.
   */
  const respondToError = async (error: unknown, ctx: HttpContext): Promise<void> => {
    // The profiler, when one wraps this request, records what broke.
    noteHandledError(error)
    // If the handler opened an SSE stream via `response.sse()` and
    // THEN threw, the reserved stream id is still on the response.
    // Tear it down before building the error response — otherwise
    // serializeResponse emits `streamId` next to an error body and
    // the HyperServer keeps feeding a dead stream slot forever.
    await ctx.response.abortStream()
    // A socket registered for a handshake that ends in an error never opens.
    ctx.response.abortWebSocket()
    try {
      // REPORT first, then handle — the AdonisJS order
      // (`#requestErrorResponder`: `await report(error, ctx)` before
      // `handle`). Handling first meant a throwing `handle()` fell into the
      // catch below and the error was never reported: it vanished from the
      // logs and the operator saw only "ExceptionHandler failed".
      await handler.report(error, ctx)
      await handler.handle(error, ctx)
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
      method: ctx.request.method(),
      path: ctx.request.url(),
      error: error instanceof Error ? error.message : String(error),
    })
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
    // The method routing uses — the spoofed one when spoofing is on, as
    // AdonisJS matches with `ctx.request.method()`. Matched with the wire
    // method, `POST /posts/1?_method=DELETE` never reached the DELETE route.
    const method =
      config.allowMethodSpoofing === true
        ? spoofedMethod(reqData.method, reqData.query)
        : reqData.method
    const match = config.router.match(method, reqData.path, host, {
      webSocket: reqData.websocket === true,
    })
    if (debugHttp.enabled) {
      debugHttp(
        '%s %s -> %s',
        method,
        reqData.path,
        match ? (match.route.name ?? match.route.path) : 'no match',
      )
    }
    // A lazy controller is imported before anything reads the route: its
    // class and action are on the route info from the first request on.
    const importFailure =
      match !== undefined && needsImport(match.route)
        ? await importController(match.route)
        : undefined
    const routeInfo = match
      ? {
          pattern: match.route.path,
          name: match.route.name,
          middleware: match.route.middleware,
          // Forward the controller class + method name onto the public
          // RouteInfo so middleware (Warden's @Guard, Photon's @Meta) can
          // read decorator metadata via Reflect. Absent for inline-arrow
          // route handlers — that's intentional, decorators only apply
          // to controller methods — and for a controller whose import
          // failed: that request ends in the import's error, never in the
          // handler.
          controller: controllerPrototype(match.route.controller?.target),
          action: match.route.controller?.method,
        }
      : { pattern: '', middleware: [] }

    // 4. Create HttpContext with its OWN resolver (Adonis
    //    `container.createResolver()`), so agnostic middleware (Warden,
    //    Blackhole) resolve host services from the context they are handed
    //    instead of importing `@c9up/ream/services/app` at runtime — and so a
    //    value bound for this request cannot be seen by any other.
    const resolver = config.container?.createResolver()
    const ctx = new HttpContext(correlationId, reqData, match?.params ?? {}, routeInfo, resolver)
    ctx.subdomains = match?.subdomains ?? {}
    // What Adonis binds on every request's resolver: the context itself, so a
    // controller or service can take `HttpContext` as a constructor dependency.
    resolver?.bindValue(HttpContext, ctx)
    if (config.jsonpCallbackName !== undefined) {
      ctx.response.setJsonpCallbackName(config.jsonpCallbackName)
    }
    if (config.cookie !== undefined) {
      ctx.response.setCookieDefaults(config.cookie)
    }
    if (config.maxResponseBytes !== undefined) {
      ctx.response.setMaxBodyBytes(config.maxResponseBytes)
    }
    if (config.allowMethodSpoofing === true) {
      // Was never wired: the setter existed but nothing called it, so a
      // migrated config asking for spoofing got a `_method` field that did
      // nothing at all.
      ctx.request.setMethodSpoofing(true)
    }
    ctx.setRouteUrlResolver((name, params) => config.router.urlFor(name, params))
    // Inject the async-resolved APP_KEY services + base logger (resolved once).
    await resolveServices()
    if (encryption) ctx.setCookieSigner(encryption)
    if (signedUrl) ctx.setSignedUrl(signedUrl)
    if (baseLogger) ctx.setBaseLogger(baseLogger)
    ctx.events = await resolveEvents()
    // Core lifecycle event: a request entered the kernel. Fire-and-forget through
    // the bus when events are wired (`?.` → zero cost when no provider). The
    // `http:response` counterpart fires before every exit below.
    ctx.events?.emit('http:request', {
      id: correlationId,
      method: reqData.method,
      path: reqData.path,
    })
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
          throw new E_ROUTE_NOT_FOUND([method, reqData.path])
        }
        // The controller could not be imported: the request ends here, as an
        // error, whatever the middleware in front let through.
        if (importFailure !== undefined) throw importFailure.error

        const hotAt = hotReloadCount()
        let cached = pipelineCache.get(match.route)
        if (cached !== undefined && cached.hotAt !== hotAt) {
          // A module was swapped since this was built. Drop the pipeline: the
          // controller was imported again above, so `import()` handed back
          // what hot-hook just invalidated rather than the copy in the ESM
          // cache, and the pipeline is rebuilt around it.
          pipelineCache.delete(match.route)
          cached = undefined
        }

        if (!cached) {
          // The lazy/string controller was promoted before the context was
          // built, so @Guard/@Role/@inject flow through the normal controller
          // path below.

          // Resolve handler (once per route)
          let routeHandler: (typeof match.route)['handler']
          if (match.route.controller) {
            routeHandler = createControllerHandler(match.route.controller, config.container)
          } else if (match.route.handler) {
            routeHandler = match.route.handler
          } else {
            throw new E_REAM_INTERNAL([
              `Route ${match.route.method} ${match.route.path} has neither controller nor handler`,
            ])
          }

          // Merge route-level guards with controller method decorator metadata (once)
          let guards = [...match.route.guards]
          let roles = [...match.route.roles]
          let permissions = [...match.route.permissions]
          let mfa = false

          if (match.route.controller) {
            const meta = readControllerGuardMetadata(
              match.route.controller.target,
              match.route.controller.method,
            )
            // `@Guard('a', 'b')` is one level: either guard, as warden reads it.
            guards = [...guards, ...(meta.guards.length > 0 ? [meta.guards] : [])]
            // `@Role('a', 'b')` requires every role, as warden's middleware
            // reads it: each one is a requirement of its own.
            roles = [...roles, ...meta.roles.map((role) => [role])]
            permissions = [...permissions, ...meta.permissions]
            mfa = meta.mfa
          }

          // Resolve route validators by name (container token `validator:<name>`).
          // A declared validator that isn't registered is a HARD error — never
          // silently skip validation, that's a security footgun (a typo'd
          // `.validate('craeteUser')` must fail loudly, not pass unvalidated).
          const validators: RuntimeValidator[] = await Promise.all(
            match.route.validators.map((name) => {
              const token = `validator:${name}`
              if (!config.container?.has(token)) {
                throw new E_VALIDATOR_NOT_FOUND([
                  `Route validator '${name}' is not registered. ` +
                    `Bind it with container.singleton('${token}', () => schema({ ... })).`,
                ])
              }
              return config.container.resolve<RuntimeValidator>(token)
            }),
          )

          // Compile pipeline once
          const chain = config.middleware.buildChain(
            match.route.middleware,
            match.route.inlineMiddleware,
            match.route.websocket === true
              ? async (c) => {
                  // Reached only once the middleware and guards have let the
                  // handshake through: the socket exists from here on.
                  await routeHandler(openWebSocket(c, config.webSocketHub?.()))
                }
              : async (c) => {
                  await routeHandler(c)
                },
            {
              guards,
              roles,
              permissions,
              mfa,
              validators,
              onError: respondToError,
              named: config.router,
              routerMiddleware: routerMw,
            },
          )

          cached = { chain, hotAt }
          pipelineCache.set(match.route, cached)
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

      // Compose: server middleware wraps everything (onion). Run inside the
      // HttpContext ALS so HttpContext.get()/getOrFail() reach this request
      // anywhere down the call stack (AdonisJS parity) — transparent to the
      // pipeline itself.
      const fullPipeline = composeMiddleware([...serverMw, coreHandler], respondToError)
      await HttpContext.run(ctx, () => fullPipeline(ctx, async () => {}))

      ctx.events?.emit('http:response', {
        id: correlationId,
        method: reqData.method,
        path: reqData.path,
        status: ctx.response.getStatus(),
      })
      if (debugHttp.enabled) {
        debugHttp(
          '%s %s <- %d (%s)',
          reqData.method,
          reqData.path,
          ctx.response.getStatus(),
          correlationId,
        )
      }
      const serialized = await serializeResponse(ctx, config.devScript)
      // The body is built; anything registered with `response.onFinish()` runs
      // now — after the answer is ready, before we hand it back.
      ctx.response.runFinishCallbacks()
      return serialized
    } catch (error) {
      // Only what fails outside the chain lands here (the chain answers its
      // own errors); it is answered the same way.
      await respondToError(error, ctx)

      ctx.events?.emit('http:response', {
        id: correlationId,
        method: reqData.method,
        path: reqData.path,
        status: ctx.response.getStatus(),
      })
      if (debugHttp.enabled) {
        debugHttp(
          '%s %s <- %d (%s)',
          reqData.method,
          reqData.path,
          ctx.response.getStatus(),
          correlationId,
        )
      }
      const serialized = await serializeResponse(ctx, config.devScript)
      // The body is built; anything registered with `response.onFinish()` runs
      // now — after the answer is ready, before we hand it back.
      ctx.response.runFinishCallbacks()
      return serialized
    }
  }
}

function createControllerHandler(
  controller: { target: AnyConstructor; method: string },
  container?: Container,
): (ctx: HttpContext) => Promise<void> {
  return async (ctx: HttpContext) => {
    // Through the REQUEST resolver when there is one: a controller taking
    // `HttpContext` as a dependency must get this request's, not a stale one.
    const resolve = ctx.containerResolver ?? container
    const instance = resolve ? await resolve.make(controller.target) : new controller.target()
    const method: unknown =
      typeof instance === 'object' && instance !== null
        ? Reflect.get(instance, controller.method)
        : undefined
    if (typeof method !== 'function') {
      throw new E_CONTROLLER_METHOD_NOT_FOUND([controller.method, controller.target.name])
    }
    await Reflect.apply(method, instance, [ctx])
  }
}

/** A controller class's prototype, where its decorators keep their metadata. */
function controllerPrototype(target: AnyConstructor | undefined): object | undefined {
  const prototype: unknown = target?.prototype
  return typeof prototype === 'object' && prototype !== null ? prototype : undefined
}

/**
 * Read the `@Guard`, `@Role`, `@Permission` and `@RequireMfa` metadata of a
 * controller action — the decorators of the auth package, under the keys it
 * writes them (`Symbol.for('warden:…')`), so ream does not import it.
 *
 * All four or none: a gate that enforced three and dropped the fourth without
 * a word left an action declared `@RequireMfa()` reachable without the
 * step-up on every stack that relies on this gate. Read through the prototype
 * chain, as the auth package reads them: an inherited action keeps its
 * parent's decorators.
 *
 * A decorator that names nothing — `@Role(...rolesFromConfig)` with an empty
 * list, or a value that is not the list the decorator writes — throws
 * `E_EMPTY_GATE_REQUIREMENT`, as `.role()` does on a route: read as "no
 * requirement", it left the action open to every request.
 */
function readControllerGuardMetadata(
  target: AnyConstructor,
  method: string,
): { guards: string[]; roles: string[]; permissions: string[]; mfa: boolean } {
  const prototype = controllerPrototype(target)
  if (prototype === undefined) return { guards: [], roles: [], permissions: [], mfa: false }
  const where = `${target.name || 'controller'}.${method}`
  const read = (key: string): unknown => Reflect.getMetadata(Symbol.for(key), prototype, method)
  return {
    guards: requirementList(read('warden:guard'), where, '@Guard()'),
    roles: requirementList(read('warden:role'), where, '@Role()'),
    permissions: requirementList(read('warden:permission'), where, '@Permission()'),
    // Truthy, as the auth package reads it: the strictest of the two readings.
    mfa: Boolean(read('warden:mfa')),
  }
}

/** The names a list-valued decorator stored: none when it is absent, refused when it names none. */
function requirementList(value: unknown, where: string, decorator: string): string[] {
  if (value === undefined) return []
  const names = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
  if (names.length === 0) throw new E_EMPTY_GATE_REQUIREMENT([where, decorator])
  return names
}

async function serializeResponse(
  ctx: HttpContext,
  devScript?: (ctx: HttpContext) => string,
): Promise<HttpKernelResponse> {
  // The terminal step, as AdonisJS' server calls `response.finish()`: it
  // stamps the request id and waits for a body still being produced.
  await ctx.response.finish()
  const streamId = ctx.response.getStreamId()
  const websocketId = ctx.response.getWebSocketId()
  // Registered, but the answer is no longer 101: the socket will not open.
  if (websocketId === undefined) ctx.response.abortWebSocket()
  else {
    const protocol = ctx.response.getWebSocketProtocol()
    if (protocol !== '') ctx.response.header('sec-websocket-protocol', protocol)
  }
  const headers = ctx.response.getHeaders()
  const body = withDevScript(
    ctx.response.getBody(),
    headers,
    streamId,
    devScript === undefined ? undefined : devScript(ctx),
  )
  return {
    status: ctx.response.getStatus(),
    headers: reconcileRepresentation(headers, ctx.response.getBody(), body),
    body,
    ...(streamId !== undefined ? { streamId } : {}),
    ...(websocketId !== undefined ? { websocketId } : {}),
  }
}

/**
 * Keep the representation headers describing the body that is actually sent.
 *
 * `content-length`, `etag` and the digest headers are computed from the body
 * BEFORE the dev reload script is appended. Left alone they describe the
 * previous one: a `content-length` short by the length of the script truncates
 * it, and an `etag` computed before the change caches modified content under an
 * unchanged validator.
 *
 * `content-length` is recomputed because it is cheap and exact; the validators
 * are DROPPED rather than recomputed, because a validator this layer invents is
 * not the one the handler meant.
 */
function reconcileRepresentation(
  headers: Record<string, string>,
  original: string,
  sent: string,
): Record<string, string> {
  if (sent === original) return headers
  const reconciled = { ...headers }
  if (reconciled['content-length'] !== undefined) {
    reconciled['content-length'] = String(Buffer.byteLength(sent, 'utf8'))
  }
  // Every validator, not the two that came to mind. `Content-Digest` and
  // `Repr-Digest` (RFC 9530) are what replaced `Digest`, and leaving them
  // describing the old body is the same defect one header along — a client
  // that checks them rejects a response that is perfectly fine.
  for (const name of [
    'etag',
    'content-md5',
    'digest',
    'content-digest',
    'repr-digest',
    'want-digest',
    'want-content-digest',
    'want-repr-digest',
  ]) {
    delete reconciled[name]
  }
  return reconciled
}

/**
 * Append the development script to an HTML body.
 *
 * Only HTML, and never a stream or a base64-encoded body (`sendBuffer`, a
 * buffered download): appending to any of them corrupts it — Rust fails to
 * decode the base64 and the client receives the encoded text — and a page is
 * the only thing that can act on the script anyway.
 * Before `</body>` when there is one, so the script is inside the document
 * rather than trailing after it.
 */
function withDevScript(
  body: string,
  headers: Record<string, string>,
  streamId: string | undefined,
  script?: string,
): string {
  if (script === undefined || streamId !== undefined || body === '') return body
  if (!(headers['content-type'] ?? '').includes('text/html')) return body
  if (headers['x-ream-body-encoding'] === 'base64') return body
  const closing = body.lastIndexOf('</body>')
  return closing === -1 ? body + script : body.slice(0, closing) + script + body.slice(closing)
}

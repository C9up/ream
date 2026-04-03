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
import { HttpContext } from './http/HttpContext.js'
import { E_ROUTE_NOT_FOUND, ExceptionHandler } from './http/Exception.js'
import type { MiddlewareFunction, MiddlewareRegistry } from './middleware/Pipeline.js'
import { compose } from './middleware/Pipeline.js'
import type { Router } from './router/Router.js'

export interface HttpKernelConfig {
  router: Router
  middleware: MiddlewareRegistry
  container?: Container
  exceptionHandler?: ExceptionHandler
  serverMiddleware?: MiddlewareFunction[]
  routerMiddleware?: MiddlewareFunction[]
  onError?: (error: unknown, ctx: HttpContext) => void
}

export function createHttpKernel(config: HttpKernelConfig): (requestJson: string) => Promise<string> {
  const handler = config.exceptionHandler ?? new ExceptionHandler(process.env.NODE_ENV !== 'production')
  const serverMw = config.serverMiddleware ?? []
  const routerMw = config.routerMiddleware ?? []

  return async (requestJson: string): Promise<string> => {
    // 1. Parse request
    let reqData: { method: string; path: string; query: string; headers: Record<string, string>; body: string }
    try {
      reqData = JSON.parse(requestJson)
    } catch {
      return JSON.stringify({ status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'E_BAD_REQUEST', message: 'Invalid request' } }) })
    }

    // 2. Correlation ID
    const CORR_ID_RE = /^[A-Za-z0-9\-_]{8,128}$/
    const rawCorrId = reqData.headers['x-request-id'] ?? reqData.headers['x-correlation-id'] ?? ''
    const correlationId = CORR_ID_RE.test(rawCorrId) ? rawCorrId : crypto.randomUUID()

    // 3. Match route
    const match = config.router.match(reqData.method, reqData.path)
    const routeInfo = match
      ? { pattern: match.route.path, name: match.route.name, middleware: match.route.middleware }
      : { pattern: '', middleware: [] }

    // 4. Create HttpContext
    const ctx = new HttpContext(correlationId, reqData, match?.params ?? {}, routeInfo)
    ctx._setRouteUrlResolver((name, params) => config.router.makeUrl(name, params))

    try {
      // 5. Build the FULL onion pipeline:
      //    Server MW → [route match check] → Router MW → Route named MW → Route inline MW → Guards → Handler
      const coreHandler: MiddlewareFunction = async (innerCtx) => {
        if (!match) {
          throw new E_ROUTE_NOT_FOUND(reqData.method, reqData.path)
        }

        // Resolve handler
        const routeHandler = match.route.controller
          ? createControllerHandler(match.route.controller, config.container)
          : match.route.handler!

        // Build inner pipeline: router MW + route MW + guards + handler
        const innerChain = config.middleware.buildChain(
          match.route.middleware,
          [...routerMw, ...match.route.inlineMiddleware],
          async (c) => { await routeHandler(c) },
          { guards: match.route.guards, roles: match.route.roles, permissions: match.route.permissions },
        )

        await innerChain(innerCtx, async () => {})
      }

      // Compose: server middleware wraps everything (onion)
      const fullPipeline = compose([...serverMw, coreHandler])
      await fullPipeline(ctx, async () => {})

      return serializeResponse(ctx)
    } catch (error) {
      try {
        await handler.handle(error, ctx)
        await handler.report(error, ctx)
      } catch (handlerError) {
        console.error('ExceptionHandler failed:', handlerError)
        ctx.response.status(500).json({ error: { code: 'E_HANDLER_FAILURE', message: 'An internal error occurred' } })
      }

      if (config.onError) {
        config.onError(error, ctx)
      }

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
    const instance = container
      ? container.make(controller.target)
      : new controller.target()
    const method = (instance as Record<string, (ctx: HttpContext) => Promise<void> | void>)[controller.method]
    if (typeof method !== 'function') {
      throw new Error(`Controller method '${controller.method}' not found on ${controller.target.name}`)
    }
    await method.call(instance, ctx)
  }
}

function serializeResponse(ctx: HttpContext): string {
  return JSON.stringify({
    status: ctx.response.getStatus(),
    headers: ctx.response.getHeaders(),
    body: ctx.response.getBody(),
  })
}

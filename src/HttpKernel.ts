/**
 * HttpKernel — bridges HyperServer NAPI with Router + Middleware Pipeline.
 *
 * This is the critical glue code that connects:
 * HyperServer (Rust/NAPI) → Context.http() → Router.match() → Pipeline → Response
 *
 * @implements FR21, FR22, FR23, FR24
 */

import { Context } from './Context.js'
import { ReamError } from './errors/ReamError.js'
import { createPipelineError } from './errors/PipelineStageError.js'
import type { MiddlewareRegistry } from './middleware/Pipeline.js'
import type { Router } from './router/Router.js'

export interface HttpKernelConfig {
  router: Router
  middleware: MiddlewareRegistry
  onError?: (error: unknown, ctx: Context) => void
}

/**
 * Creates the onRequest callback for HyperServer.
 *
 * Usage:
 *   const kernel = createHttpKernel({ router, middleware })
 *   hyperServer.onRequest(kernel)
 */
export function createHttpKernel(config: HttpKernelConfig): (requestJson: string) => Promise<string> {
  return async (requestJson: string): Promise<string> => {
    // 1. Parse the ReamRequest JSON from Rust
    let reqData: {
      method: string
      path: string
      query: string
      headers: Record<string, string>
      body: string
    }

    try {
      reqData = JSON.parse(requestJson)
    } catch {
      return JSON.stringify({ status: 400, body: 'Invalid request' })
    }

    // 2. Extract or generate correlation ID (validated format)
    const CORR_ID_RE = /^[A-Za-z0-9\-_]{8,128}$/
    const rawCorrId = reqData.headers['x-request-id'] ?? reqData.headers['x-correlation-id'] ?? ''
    const correlationId = CORR_ID_RE.test(rawCorrId) ? rawCorrId : crypto.randomUUID()

    // 3. Create unified Context
    const ctx = Context.http(correlationId, {
      method: reqData.method,
      path: reqData.path,
      query: reqData.query,
      headers: reqData.headers,
      body: reqData.body,
    })

    try {
      // 4. Match route
      const match = config.router.match(reqData.method, reqData.path)

      if (!match) {
        return JSON.stringify({
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: { code: 'NOT_FOUND', message: `Route not found: ${reqData.method} ${reqData.path}` } }),
        })
      }

      // 5. Extract params into context
      ctx.params = match.params

      // 6. Build and execute middleware pipeline (with guard enforcement)
      const chain = config.middleware.buildChain(
        match.route.middleware,
        async (innerCtx) => {
          await match.route.handler(innerCtx)
        },
        { guards: match.route.guards, roles: match.route.roles, permissions: match.route.permissions },
      )

      await chain(ctx, async () => {})

      // 7. Serialize response back to Rust
      return JSON.stringify({
        status: ctx.response?.status ?? 200,
        headers: ctx.response?.headers ?? {},
        body: ctx.response?.body ?? '',
      })
    } catch (error) {
      // Error boundary — catch handler/middleware errors
      if (config.onError) {
        config.onError(error, ctx)
      }

      // Wrap in pipeline error with stage context
      const reamError = error instanceof ReamError
        ? error
        : createPipelineError(7, error instanceof Error ? error : new Error(String(error)))

      // Redact error details in production
      const message = process.env.NODE_ENV === 'production'
        ? 'An internal error occurred'
        : reamError.message

      return JSON.stringify({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: reamError.code,
            message,
          },
        }),
      })
    }
  }
}

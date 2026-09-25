/**
 * The middleware that records a request.
 *
 * It wraps everything after it, so what it measures is the whole answer — the
 * application's own middleware included — and it stamps the token on the
 * response first thing. That header is how a client finds the profile again;
 * the injected bar carries the same token inline, because a script in a page
 * cannot read the headers of the navigation that delivered it.
 *
 * Registered AFTER the profiler's own endpoint and the hot-reload stream, so
 * neither ends up in its own history — and so a reload stream, which is open
 * for as long as the tab is, never sits in the middle of an unfinished profile.
 */

import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareFunction } from '../middleware/Pipeline.js'
import type { RequestBag } from './collectors.js'
import { PROFILER_TOKEN_HEADER, type Profiler } from './Profiler.js'

export function profileRequest(profiler: Profiler): MiddlewareFunction {
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    await profiler.profile(
      { method: ctx.request.method(), url: ctx.request.url() },
      async (scope) => {
        // Before the work, not after: a handler that throws unwinds past this
        // line, and the request that broke is the one whose profile you most
        // want to open.
        ctx.response.header(PROFILER_TOKEN_HEADER, scope.token)
        try {
          await next()
        } finally {
          // After routing, because this runs ahead of it: the pattern and the
          // controller are only on the context once a route has matched. In a
          // `finally`, because a request that threw still matched one.
          describeRoute(profiler.current<RequestBag>('request'), ctx)
        }
      },
      (error) => ({ status: statusOf(ctx, error) }),
    )
  }
}

/**
 * The status the response will carry.
 *
 * When the work threw, the exception handler has not run yet — the error is
 * still travelling outwards — so the response still holds whatever it held
 * before. Read the error the way the handler will instead, and fall back to
 * 500, which is what an error carrying no status becomes.
 */
function statusOf(ctx: HttpContext, error: unknown): number {
  if (error === undefined) return ctx.response.getStatus()
  if (typeof error === 'object' && error !== null) {
    const status = Reflect.get(error, 'status') ?? Reflect.get(error, 'statusCode')
    if (typeof status === 'number' && Number.isInteger(status)) return status
  }
  return 500
}

/**
 * What matched, as the request panel shows it.
 *
 * Read off the context rather than passed in, and every field optional: a 404
 * matched nothing, and an inline handler has no controller to name.
 */
function describeRoute(bag: RequestBag | undefined, ctx: HttpContext): void {
  if (bag === undefined) return
  const route = ctx.route
  if (route === undefined) return
  bag.route = route.name ?? route.pattern
  const controller = route.controller
  if (controller !== undefined && route.action !== undefined) {
    // `route.controller` is the PROTOTYPE, not the class — that is what the
    // decorator-reading middleware needs — so the name is on its constructor.
    const name = Reflect.get(Reflect.get(controller, 'constructor') ?? {}, 'name')
    bag.controller = `${typeof name === 'string' ? name : 'Controller'}.${route.action}`
  }
  const user = ctx.auth?.user
  if (typeof user === 'object' && user !== null) {
    const id = Reflect.get(user, 'id')
    if (typeof id === 'string' || typeof id === 'number') bag.userId = String(id)
  }
}

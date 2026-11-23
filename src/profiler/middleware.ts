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
import { listenForHandledErrors } from './handledError.js'
import { PROFILER_TOKEN_HEADER, type Profiler } from './Profiler.js'
import { isSecretKey, preview, REDACTED } from './preview.js'

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
          // The kernel answers an error where it is thrown, so `next()`
          // resolves for a request that failed: the error comes through here.
          await listenForHandledErrors((error) => profiler.recordException(error), next)
        } finally {
          // After routing, because this runs ahead of it: the pattern and the
          // controller are only on the context once a route has matched. In a
          // `finally`, because a request that threw still matched one.
          describeRequest(profiler.current<RequestBag>('request'), ctx)
        }
      },
      (error) => ({ status: statusOf(ctx, error) }),
    )
  }
}

/**
 * The status the response will carry.
 *
 * The kernel answers an error before `next()` resolves, so the response
 * already holds its status. Only an error the kernel never saw (a middleware
 * ahead of this one, a kernel built without error handling) arrives here
 * thrown: read it the way the handler would, and fall back to 500, which is
 * what an error carrying no status becomes.
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
 * The request and its answer, as the request panel shows them.
 *
 * Each part is read on its own: one accessor that throws (a body the parser
 * refused, a session store that is down) costs its own row, not the panel.
 */
function describeRequest(bag: RequestBag | undefined, ctx: HttpContext): void {
  if (bag === undefined) return
  const request = ctx.request
  attempt(() => {
    const safe = request.serializeSafe()
    bag.headers = safe.headers
    bag.query = preview(safe.qs)
    bag.params = preview(safe.params)
  })
  attempt(() => {
    bag.path = request.path()
    bag.ip = request.ip()
    bag.ajax = request.ajax()
    const id = request.id()
    if (id !== undefined) bag.requestId = id
  })
  attempt(() => {
    // Names only: a cookie's value is a session id or a signed token.
    bag.cookies = Object.keys(request.cookiesList())
  })
  attempt(() => {
    const body = request.body()
    const sent =
      request.hasBody() ||
      (typeof body === 'string'
        ? body !== ''
        : typeof body === 'object' && body !== null && Object.keys(body).length > 0)
    if (sent) bag.body = preview(body)
  })
  attempt(() => {
    const session = ctx.session
    if (session !== undefined) bag.session = preview(session.all())
  })
  attempt(() => {
    const response = ctx.response
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(response.getHeaders())) {
      headers[name] = name === 'set-cookie' || isSecretKey(name) ? REDACTED : value
    }
    const contentType = response.getHeader('content-type')
    bag.response = {
      status: response.getStatus(),
      headers,
      ...(contentType === undefined ? {} : { contentType }),
    }
  })
  describeRoute(bag, ctx)
}

function attempt(read: () => void): void {
  try {
    read()
  } catch {
    // One unreadable part of the request; the rest of the panel still shows.
  }
}

/**
 * What matched.
 *
 * Read off the context rather than passed in, and every field optional: a 404
 * matched nothing, and an inline handler has no controller to name.
 */
function describeRoute(bag: RequestBag, ctx: HttpContext): void {
  const user = ctx.auth?.user
  if (typeof user === 'object' && user !== null) {
    const id = Reflect.get(user, 'id')
    if (typeof id === 'string' || typeof id === 'number') bag.userId = String(id)
    bag.user = preview(user)
  }
  const route = ctx.route
  if (route === undefined) return
  bag.route = route.name ?? route.pattern
  bag.pattern = route.pattern
  const controller = route.controller
  if (controller !== undefined && route.action !== undefined) {
    // `route.controller` is the PROTOTYPE, not the class — that is what the
    // decorator-reading middleware needs — so the name is on its constructor.
    const name = Reflect.get(Reflect.get(controller, 'constructor') ?? {}, 'name')
    bag.controller = `${typeof name === 'string' ? name : 'Controller'}.${route.action}`
  }
}

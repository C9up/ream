/**
 * Where the toolbar and the profiler read from.
 *
 * Three routes, all under `/__ream/profiler` and all development-only:
 *
 *     /__ream/profiler                 the history, newest first
 *     /__ream/profiler/<token>         one request, every panel
 *     /__ream/profiler/<token>.json    the same, for the bar in the page
 *
 * Server middleware rather than routes, like the hot-reload endpoint: it
 * answers before the application's own middleware, so a profiler request does
 * not run the authentication stack and end up in its own history.
 */

import type { Profiler } from './Profiler.js'
import { PROFILER_PATH } from './Profiler.js'
import { renderProfileList, renderProfilePage } from './render.js'

/** The slice of the context this endpoint uses. */
export interface ProfilerContext {
  request: { url: () => string }
  response: {
    header: (name: string, value: string) => unknown
    send: (body: unknown) => unknown
    status: (code: number) => unknown
  }
}

export function profilerEndpoint(
  profiler: Profiler,
): (ctx: ProfilerContext, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    const path = ctx.request.url().split('?')[0] ?? ''
    if (path !== PROFILER_PATH && !path.startsWith(`${PROFILER_PATH}/`)) {
      await next()
      return
    }

    if (path === PROFILER_PATH) {
      ctx.response.header('content-type', 'text/html; charset=utf-8')
      ctx.response.send(renderProfileList(profiler.store.recent(50)))
      return
    }

    const rest = path.slice(`${PROFILER_PATH}/`.length)
    const asJson = rest.endsWith('.json')
    const token = asJson ? rest.slice(0, -'.json'.length) : rest
    const profile = profiler.store.find(token)

    if (profile === undefined) {
      // 404 rather than an empty page: a token the store has dropped is a real
      // answer, and the bar reads the status to stop asking.
      ctx.response.status(404)
      if (asJson) {
        ctx.response.header('content-type', 'application/json')
        ctx.response.send({ error: 'no profile for this token' })
      } else {
        ctx.response.header('content-type', 'text/html; charset=utf-8')
        ctx.response.send(renderProfileList(profiler.store.recent(50), token))
      }
      return
    }

    if (asJson) {
      ctx.response.header('content-type', 'application/json')
      // No cache: the token is single-use in practice, and a cached profile
      // would show the previous request's numbers after a reload.
      ctx.response.header('cache-control', 'no-store')
      ctx.response.send({
        ...profile,
        badges: badgesFor(profiler, profile.data),
      })
      return
    }

    ctx.response.header('content-type', 'text/html; charset=utf-8')
    ctx.response.send(renderProfilePage(profile, badgesFor(profiler, profile.data)))
  }
}

/** Each collector's headline, asked of the collector rather than guessed. */
function badgesFor(
  profiler: Profiler,
  data: Record<string, Record<string, unknown>>,
): Record<string, string> {
  const badges: Record<string, string> = {}
  for (const collector of profiler.collectors) {
    const panel = data[collector.name]
    if (panel === undefined || collector.badge === undefined) continue
    try {
      const badge = collector.badge(panel)
      if (badge !== undefined) badges[collector.name] = badge
    } catch {
      // A badge that throws costs its own label, nothing more.
    }
  }
  return badges
}

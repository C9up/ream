/**
 * `router.on(path).render(template)` — a route with no handler of its own
 * (AdonisJS brisk `render`).
 *
 * It looked only in `ctx.store` under `view`, which nothing has ever
 * populated, so the route always threw "View engine not configured" — and the
 * message named the wrong package. It now reads the per-request `ctx.view` the
 * template provider installs.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { Router } from '../../src/router/Router.js'

/**
 * A real `HttpContext`, with its response watched and a view attached.
 *
 * The fake here used to be `{ store, response: { type, send } }` — a partial
 * shape the handler's parameter does not accept, which is why this file sat
 * outside the typecheck. A real context costs four arguments and cannot drift
 * from what a handler is actually given.
 */
function contextWith(extra: { view?: unknown } = {}): {
  ctx: HttpContext
  sent: { body?: string; type?: string }
} {
  const sent: { body?: string; type?: string } = {}
  const raw: RawRequest = { method: 'GET', path: '/about', query: '', headers: {}, body: '' }
  const ctx = new HttpContext('req-brisk', raw, {}, { pattern: '/about', middleware: [] })

  const response = ctx.response
  const type = response.type.bind(response)
  response.type = (value: string) => {
    sent.type = value
    return type(value)
  }
  response.send = (body: string) => {
    sent.body = body
  }
  if (extra.view !== undefined) {
    Object.defineProperty(ctx, 'view', { value: extra.view, configurable: true })
  }
  return { ctx, sent }
}

describe('ream > router.on().render()', () => {
  it('renders through the request view', async () => {
    const router = new Router()
    router.on('/about').render('pages/about', { title: 'About' })
    const { ctx, sent } = contextWith({
      view: {
        render: (name: string, data?: Record<string, unknown>) =>
          Promise.resolve(`${name}:${String(data?.title)}`),
      },
    })
    const matched = router.match('GET', '/about')
    expect(matched).toBeDefined()
    await matched?.route.handler?.(ctx)
    expect(sent.body).toBe('pages/about:About')
    expect(sent.type).toContain('text/html')
  })

  it('still honours an engine seeded into ctx.store', async () => {
    const router = new Router()
    router.on('/legacy').render('pages/legacy')
    const { ctx, sent } = contextWith({})
    ctx.store.set('view', { render: (n: string) => Promise.resolve(`store:${n}`) })
    const matched = router.match('GET', '/legacy')
    await matched?.route.handler?.(ctx)
    expect(sent.body).toBe('store:pages/legacy')
  })

  it('names what is missing instead of the wrong package', async () => {
    const router = new Router()
    router.on('/none').render('pages/none')
    const { ctx } = contextWith({})
    const matched = router.match('GET', '/none')
    await expect(matched?.route.handler?.(ctx)).rejects.toThrow(/E_NO_VIEW_ENGINE/)
  })
})

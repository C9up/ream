/**
 * The per-request resolver, seen from a real request.
 *
 * AdonisJS binds the `HttpContext` on every request's resolver, so a controller
 * (or anything it depends on) can take it as a constructor dependency. Ream
 * handed the APPLICATION container over as `ctx.containerResolver`, so that
 * injection resolved to nothing — and a value bound on it would have been
 * visible to every other request in flight.
 */

import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import {
  Container,
  createHttpKernel,
  HttpContext,
  Inject,
  MiddlewareRegistry,
  Router,
} from '../../src/index.js'

/** A service that needs the request it is serving, not some other one. */
class Auditor {
  constructor(@Inject(HttpContext) readonly ctx: HttpContext) {}
  trail(): string {
    return this.ctx.request.url()
  }
}

class AuditController {
  constructor(@Inject(Auditor) readonly auditor: Auditor) {}
  async show(ctx: HttpContext): Promise<void> {
    ctx.response.json({ trail: this.auditor.trail() })
  }
}

function kernelFor(): ReturnType<typeof createHttpKernel> {
  const router = new Router()
  const middleware = new MiddlewareRegistry()
  const container = new Container()
  router.get('/audit/:id', [async () => ({ default: AuditController }), 'show'])
  return createHttpKernel({ router, middleware, container })
}

describe('HttpKernel > per-request container resolver', () => {
  it('injects THIS request context into a controller dependency', async () => {
    const kernel = kernelFor()

    const response = await kernel({
      method: 'GET',
      path: '/audit/7',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).trail).toContain('/audit/7')
  })

  it('does not hand one request its neighbour context', async () => {
    // Both in flight at once: the whole point of an isolated resolver.
    const kernel = kernelFor()

    const [a, b] = await Promise.all([
      kernel({ method: 'GET', path: '/audit/1', query: '', headers: {}, body: '' }),
      kernel({ method: 'GET', path: '/audit/2', query: '', headers: {}, body: '' }),
    ])

    expect(JSON.parse(a.body).trail).toContain('/audit/1')
    expect(JSON.parse(b.body).trail).toContain('/audit/2')
  })

  it('exposes the resolver on the context with the Adonis surface', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const container = new Container()
    container.singleton('mailer', () => ({ sent: true }))
    let seen: unknown
    router.get('/probe', async (ctx: HttpContext) => {
      const resolver = ctx.containerResolver
      seen = {
        hasMailer: resolver?.hasBinding('mailer'),
        // Bound by the kernel on every request, as AdonisJS does.
        context: (await resolver?.make<HttpContext>(HttpContext)) === ctx,
      }
      ctx.response.json({})
    })
    const kernel = createHttpKernel({ router, middleware, container })

    await kernel({ method: 'GET', path: '/probe', query: '', headers: {}, body: '' })

    expect(seen).toEqual({ hasMailer: true, context: true })
  })
})

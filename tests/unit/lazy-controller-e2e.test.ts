import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container, createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'

/** A dependency the controller expects the container to inject. */
class Clock {
  now(): string {
    return '2026-07-04'
  }
}

/** Controller resolved through the container (constructor DI). */
class ReportsController {
  constructor(readonly clock: Clock) {}
  async show(ctx: import('../../src/http/HttpContext.js').HttpContext): Promise<void> {
    ctx.response.json({ date: this.clock.now(), id: ctx.params.id })
  }
}

describe('HttpKernel > lazy + string controller resolution (e2e)', () => {
  it('loads a lazy-import controller on request and resolves it via the container', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const container = new Container()
    container.singleton(ReportsController, () => new ReportsController(new Clock()))

    router.get('/reports/:id', [async () => ({ default: ReportsController }), 'show'])

    const kernel = createHttpKernel({ router, middleware, container })
    const response = await kernel({
      method: 'GET',
      path: '/reports/7',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(200)
    const body = JSON.parse(response.body)
    // The injected Clock ran → DI flowed through the promoted controller path.
    expect(body.date).toBe('2026-07-04')
    expect(body.id).toBe('7')
  })

  it('resolves a "Controller.method" string reference via the registry', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const container = new Container()
    container.singleton(ReportsController, () => new ReportsController(new Clock()))

    router.controllers({ ReportsController: async () => ({ default: ReportsController }) })
    router.get('/r/:id', 'ReportsController.show')

    const kernel = createHttpKernel({ router, middleware, container })
    const response = await kernel({
      method: 'GET',
      path: '/r/42',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).id).toBe('42')
  })
})

import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container } from '../../../src/container/Container.js'
import { Emitter } from '../../../src/events/Emitter.js'
import EventsProvider from '../../../src/events/EventsProvider.js'
import { createHttpKernel, MiddlewareRegistry, Router } from '../../../src/index.js'

function req(path: string) {
  return { method: 'GET', path, query: '', headers: {}, body: '' }
}

describe('events > ctx.events wiring', () => {
  it('attaches the emitter to ctx when EventsProvider is registered', async () => {
    const container = new Container()
    new EventsProvider({ container }).register()

    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let captured: unknown
    const received: unknown[] = []
    router.get('/ping', async (ctx) => {
      captured = ctx.events
      ctx.events?.on('pinged', (d) => received.push(d))
      ctx.events?.emit('pinged', { ok: true })
      ctx.response.json({ ok: true })
    })

    const kernel = createHttpKernel({ router, middleware, container })
    const res = await kernel(req('/ping'))

    expect(res.status).toBe(200)
    expect(captured).toBeInstanceOf(Emitter)
    expect(received).toEqual([{ ok: true }])
  })

  it('emits an "exception" core event when a handler throws', async () => {
    const container = new Container()
    new EventsProvider({ container }).register()
    const emitter = container.resolve<Emitter>('events')
    const errors: Array<{ path: string; error: string }> = []
    emitter.on('exception', (e) => errors.push(e as { path: string; error: string }))

    const router = new Router()
    const middleware = new MiddlewareRegistry()
    router.get('/boom', async () => {
      throw new Error('kaboom')
    })

    const kernel = createHttpKernel({ router, middleware, container })
    const res = await kernel(req('/boom'))

    expect(res.status).toBe(500)
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe('/boom')
    expect(errors[0].error).toBe('kaboom')
  })

  it('leaves ctx.events undefined when no EventsProvider is registered', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let captured: unknown = 'unset'
    router.get('/ping', async (ctx) => {
      captured = ctx.events
      ctx.response.json({ ok: true })
    })

    const kernel = createHttpKernel({ router, middleware })
    await kernel(req('/ping'))
    expect(captured).toBeUndefined()
  })
})

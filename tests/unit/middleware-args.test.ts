import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { Router } from '../../src/router/Router.js'
import {
  type MiddlewareClass,
  resolveParametrizedMiddlewareEntry,
} from '../../src/server/Server.js'
import { defined } from '../__helpers__/defined.js'

const RAW: RawRequest = { method: 'GET', path: '/', query: '', headers: {}, body: '' }
function makeCtx(): HttpContext {
  return new HttpContext('req-1', RAW, {}, { pattern: '/', middleware: [] })
}

/** Middleware that records the per-route args it was handed. */
class TagMiddleware implements MiddlewareClass {
  async handle(ctx: HttpContext, next: () => Promise<void>, args?: unknown): Promise<void> {
    ctx.store.set('args', args)
    await next()
  }
}

describe('resolveParametrizedMiddlewareEntry (AdonisJS handle(ctx,next,args))', () => {
  it('forwards factory args to the class handle()', async () => {
    const factory = resolveParametrizedMiddlewareEntry(async () => ({ default: TagMiddleware }))
    const mw = factory({ guards: ['web'] })
    const ctx = makeCtx()
    await mw(ctx, async () => {})
    expect(ctx.store.get('args')).toEqual({ guards: ['web'] })
  })

  it('a plain-function middleware runs and ignores args', async () => {
    let ran = false
    const factory = resolveParametrizedMiddlewareEntry(async (_ctx, next) => {
      ran = true
      await next()
    })
    await factory({ anything: 1 })(makeCtx(), async () => {})
    expect(ran).toBe(true)
  })
})

describe('router.named — factories + by-name registration', () => {
  it('returns factories that bake in args', async () => {
    const router = new Router()
    const middleware = router.named({ tag: async () => ({ default: TagMiddleware }) })

    const ctx = makeCtx()
    await defined(middleware.tag)({ role: 'admin' })(ctx, async () => {})
    expect(ctx.store.get('args')).toEqual({ role: 'admin' })
  })

  it('still registers the no-arg form for by-name route resolution', () => {
    const router = new Router()
    router.named({ tag: async () => ({ default: TagMiddleware }) })
    expect(router.getNamedMiddleware('tag')).toBeDefined()
  })
})

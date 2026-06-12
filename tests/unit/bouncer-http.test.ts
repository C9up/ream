import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { Authorizer, HttpContext } from '../../src/http/HttpContext.js'
import { createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'

function req(path: string) {
  return { method: 'GET', path, query: '', headers: { accept: 'application/json' }, body: '' }
}

/** Mirrors warden's WardenError shape: a real Error carrying status + code. */
class AuthorizationFailure extends Error {
  readonly status = 403
  readonly code = 'WARDEN_AUTHORIZATION_FAILURE'
  constructor() {
    super('You are not authorized to perform this action')
    this.name = 'WardenError'
  }
}

const denying: Authorizer = {
  allows: async () => false,
  denies: async () => true,
  authorize: async () => {
    throw new AuthorizationFailure()
  },
}

const allowing: Authorizer = {
  allows: async () => true,
  denies: async () => false,
  authorize: async () => {},
}

/** Global middleware that attaches a bouncer to ctx, mirroring warden's initializeBouncer. */
function attach(bouncer: Authorizer) {
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    ctx.bouncer = bouncer
    await next()
  }
}

describe('bouncer > HTTP authorization integration (56.6)', () => {
  it('maps a denied authorize() to a 403 response with the warden code', async () => {
    const router = new Router()
    router.get('/admin', async (ctx) => {
      await ctx.bouncer?.authorize('admin.access')
      ctx.response.json({ ok: true })
    })

    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [attach(denying)],
    })
    const res = await kernel(req('/admin'))

    expect(res.status).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe('WARDEN_AUTHORIZATION_FAILURE')
  })

  it('lets the handler proceed when authorize() resolves', async () => {
    const router = new Router()
    router.get('/admin', async (ctx) => {
      await ctx.bouncer?.authorize('admin.access')
      ctx.response.json({ ok: true })
    })

    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [attach(allowing)],
    })
    const res = await kernel(req('/admin'))

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('supports branching on allows() without throwing', async () => {
    const router = new Router()
    router.get('/maybe', async (ctx) => {
      const ok = await ctx.bouncer?.allows('thing')
      ctx.response.status(ok ? 200 : 202).json({ ok })
    })

    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [attach(denying)],
    })
    const res = await kernel(req('/maybe'))

    expect(res.status).toBe(202)
    expect(JSON.parse(res.body)).toEqual({ ok: false })
  })
})

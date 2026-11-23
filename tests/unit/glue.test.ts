import 'reflect-metadata'
import { createError, Exception } from '@c9up/flare'
import { describe, expect, it } from 'vitest'
import { getServiceRegistry } from '../../src/decorators/Service.js'
import {
  Container,
  clearServiceRegistry,
  createHttpKernel,
  MiddlewareRegistry,
  Router,
} from '../../src/index.js'

describe('HttpKernel > integration', () => {
  it('routes request through router and pipeline to handler', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()

    router.get('/orders/:id', async (ctx) => {
      ctx.response.json({ orderId: ctx.params.id })
    })

    const kernel = createHttpKernel({ router, middleware })

    const response = await kernel({
      method: 'GET',
      path: '/orders/123',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).orderId).toBe('123')
  })

  it('exposes the app container as ctx.containerResolver — service resolves end-to-end (Adonis idiom)', async () => {
    // Regression: ream's HttpContext must carry the IoC resolver so agnostic
    // middleware (Warden, Blackhole) resolve host services from the ctx they
    // are HANDED — never by importing `@c9up/ream/services/app` at runtime.
    // Before this, ctx had no container and that whole contract was missing.
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const container = new Container()
    const greeter = { hello: () => 'hi from container' }
    container.singleton('greeter', () => greeter)

    let resolved: { hello(): string } | undefined
    router.get('/svc', async (ctx) => {
      resolved = await ctx.containerResolver?.make<{ hello(): string }>('greeter')
      ctx.response.json({ ok: resolved !== undefined })
    })

    const kernel = createHttpKernel({ router, middleware, container })
    const response = await kernel({
      method: 'GET',
      path: '/svc',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).ok).toBe(true)
    // `.make()` returns the very instance registered in the app container.
    expect(resolved).toBe(greeter)
  })

  it('leaves ctx.containerResolver undefined when the kernel has no container (mock server)', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let seen: unknown = 'unset'
    router.get('/no-container', async (ctx) => {
      seen = ctx.containerResolver
      ctx.response.json({})
    })
    const kernel = createHttpKernel({ router, middleware })
    await kernel({ method: 'GET', path: '/no-container', query: '', headers: {}, body: '' })
    expect(seen).toBeUndefined()
  })

  it('returns 404 for unmatched route', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const kernel = createHttpKernel({ router, middleware })

    const response = await kernel({
      method: 'GET',
      path: '/nonexistent',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(404)
  })

  it('executes middleware before handler', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const log: string[] = []

    middleware.use(async (_ctx, next) => {
      log.push('middleware')
      await next()
    })

    router.get('/test', async () => {
      log.push('handler')
    })

    const kernel = createHttpKernel({ router, middleware })
    await kernel({
      method: 'GET',
      path: '/test',
      query: '',
      headers: {},
      body: '',
    })

    expect(log).toEqual(['middleware', 'handler'])
  })

  it('answers a generic message for a 500 Exception thrown from a route, outside debug mode', async () => {
    const E_POOL_DOWN = createError<[string]>('pool exhausted on %s', 'E_POOL_DOWN')
    const E_QUOTA = createError('Quota exceeded', 'E_QUOTA', 429)
    const router = new Router()
    router.get('/down', async () => {
      throw new E_POOL_DOWN(['db-internal-3'])
    })
    router.get('/quota', async () => {
      throw new E_QUOTA()
    })
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })
    const call = (path: string) =>
      kernel({ method: 'GET', path, query: '', headers: { accept: 'application/json' }, body: '' })

    const down = await call('/down')
    expect(down.status).toBe(500)
    expect(JSON.parse(down.body).error).toMatchObject({
      code: 'E_POOL_DOWN',
      message: 'An internal error occurred',
    })
    expect(down.body).not.toContain('db-internal-3')

    const quota = await call('/quota')
    expect(quota.status).toBe(429)
    expect(JSON.parse(quota.body).error).toMatchObject({
      code: 'E_QUOTA',
      message: 'Quota exceeded',
    })
  })

  it('catches handler errors and returns 500', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const errors: unknown[] = []

    router.get('/error', async () => {
      throw new Exception('Something broke', { code: 'HANDLER_ERROR' })
    })

    const kernel = createHttpKernel({
      router,
      middleware,
      onError: (err) => errors.push(err),
    })

    const response = await kernel({
      method: 'GET',
      path: '/error',
      query: '',
      // An API client says so; without it the handler renders the error page.
      headers: { accept: 'application/json' },
      body: '',
    })

    expect(response.status).toBe(500)
    expect(JSON.parse(response.body).error.code).toBe('HANDLER_ERROR')
    expect(errors.length).toBe(1)
  })

  it('extracts correlation ID from x-request-id header', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let capturedId = ''

    middleware.use(async (ctx, next) => {
      capturedId = ctx.id
      await next()
    })

    router.get('/test', async () => {})

    const kernel = createHttpKernel({ router, middleware })
    await kernel({
      method: 'GET',
      path: '/test',
      query: '',
      headers: { 'x-request-id': 'req-abc-123' },
      body: '',
    })

    expect(capturedId).toBe('req-abc-123')
  })
})

describe('clearServiceRegistry > test isolation', () => {
  it('clears the global registry', async () => {
    clearServiceRegistry()
    expect(getServiceRegistry().size).toBe(0)
  })
})

describe('the kernel echoes the caller request id (AdonisJS `finish`)', () => {
  function kernelFor(handler: () => void) {
    const router = new Router()
    router.get('/x', handler)
    return createHttpKernel({ router, middleware: new MiddlewareRegistry() })
  }

  it('sends x-request-id back without the handler asking', async () => {
    const kernel = kernelFor(() => {})
    const response = await kernel({
      method: 'GET',
      path: '/x',
      query: '',
      headers: { 'x-request-id': 'abc-123' },
      body: '',
    })

    // AdonisJS calls setRequestId() from response.finish(), so the echo is a
    // property of every response rather than something each handler remembers.
    expect(response.headers['x-request-id']).toBe('abc-123')
  })

  it('invents nothing when the caller sent none', async () => {
    const kernel = kernelFor(() => {})
    const response = await kernel({
      method: 'GET',
      path: '/x',
      query: '',
      headers: {},
      body: '',
    })

    // ctx.id still gets a generated one; handing it back would name an id the
    // caller never used.
    expect(response.headers['x-request-id']).toBeUndefined()
  })

  it('echoes it on an error response too', async () => {
    const kernel = kernelFor(() => {
      throw new Error('boom')
    })
    const response = await kernel({
      method: 'GET',
      path: '/x',
      query: '',
      headers: { 'x-request-id': 'trace-me' },
      body: '',
    })

    // The response an exception handler produced is the one an operator most
    // needs to correlate.
    expect(response.status).toBe(500)
    expect(response.headers['x-request-id']).toBe('trace-me')
  })
})

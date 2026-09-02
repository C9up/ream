import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import {
  Container,
  clearServiceRegistry,
  createHttpKernel,
  MiddlewareRegistry,
  ReamError,
  Router,
} from '../../src/index.js'

describe('ReamError > construction', () => {
  it('creates error with code and message', () => {
    const err = new ReamError('MY_CODE', 'Something broke')
    expect(err.code).toBe('MY_CODE')
    expect(err.message).toBe('Something broke')
    expect(err.name).toBe('ReamError')
    expect(err).toBeInstanceOf(Error)
  })

  it('creates error with full options', () => {
    const err = new ReamError('E_ATLAS_ERROR', 'Column not found', {
      context: { entity: 'Order', column: 'statut' },
      hint: 'Did you mean: status?',
      sourceFile: 'crates/ream-query/src/compiler.rs',
      sourceLine: 142,
      docsUrl: 'https://docs.ream.dev/errors/E_ATLAS_ERROR',
    })
    expect(err.context.entity).toBe('Order')
    expect(err.hint).toBe('Did you mean: status?')
    expect(err.docsUrl).toContain('docs.ream.dev')
  })
})

describe('ReamError > fromNapi', () => {
  it('parses JSON error from Rust NAPI', () => {
    const napiError = new Error(
      JSON.stringify({
        code: 'RUST_PANIC',
        message: 'Panic caught',
        hint: 'Report this bug',
        sourceFile: 'lib.rs',
        sourceLine: 42,
      }),
    )

    const err = ReamError.fromNapi(napiError)
    expect(err.code).toBe('RUST_PANIC')
    expect(err.message).toBe('Panic caught')
    expect(err.hint).toBe('Report this bug')
    expect(err.sourceFile).toBe('lib.rs')
  })

  it('falls back to E_UNKNOWN for non-JSON errors', () => {
    const err = ReamError.fromNapi(new Error('plain error'))
    expect(err.code).toBe('E_UNKNOWN')
    expect(err.message).toBe('plain error')
  })
})

describe('ReamError > toDevString', () => {
  it('formats for dev console', () => {
    const err = new ReamError('TEST', 'Test error', {
      hint: 'Fix this',
      context: { key: 'value' },
      sourceFile: 'test.ts',
      sourceLine: 10,
    })
    const output = err.toDevString()
    expect(output).toContain('[TEST]')
    expect(output).toContain('test.ts:10')
    expect(output).toContain('key: value')
    expect(output).toContain('Hint: Fix this')
  })
})

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

  it('catches handler errors and returns 500', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const errors: unknown[] = []

    router.get('/error', async () => {
      throw new ReamError('HANDLER_ERROR', 'Something broke')
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
    const { getServiceRegistry } = await import('../../src/decorators/Service.js')
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

import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import {
  Context,
  MiddlewareRegistry,
  ReamError,
  Router,
  clearServiceRegistry,
  createHttpKernel,
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
    const err = new ReamError('ATLAS_ERROR', 'Column not found', {
      context: { entity: 'Order', column: 'statut' },
      hint: 'Did you mean: status?',
      sourceFile: 'crates/ream-query/src/compiler.rs',
      sourceLine: 142,
      docsUrl: 'https://docs.ream.dev/errors/ATLAS_ERROR',
    })
    expect(err.context.entity).toBe('Order')
    expect(err.hint).toBe('Did you mean: status?')
    expect(err.docsUrl).toContain('docs.ream.dev')
  })
})

describe('ReamError > fromNapi', () => {
  it('parses JSON error from Rust NAPI', () => {
    const napiError = new Error(JSON.stringify({
      code: 'RUST_PANIC',
      message: 'Panic caught',
      hint: 'Report this bug',
      sourceFile: 'lib.rs',
      sourceLine: 42,
    }))

    const err = ReamError.fromNapi(napiError)
    expect(err.code).toBe('RUST_PANIC')
    expect(err.message).toBe('Panic caught')
    expect(err.hint).toBe('Report this bug')
    expect(err.sourceFile).toBe('lib.rs')
  })

  it('falls back to UNKNOWN for non-JSON errors', () => {
    const err = ReamError.fromNapi(new Error('plain error'))
    expect(err.code).toBe('UNKNOWN')
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
      ctx.response!.status = 200
      ctx.response!.headers['content-type'] = 'application/json'
      ctx.response!.body = JSON.stringify({ orderId: ctx.params?.id })
    })

    const kernel = createHttpKernel({ router, middleware })

    const responseJson = await kernel(JSON.stringify({
      method: 'GET',
      path: '/orders/123',
      query: '',
      headers: {},
      body: '',
    }))

    const response = JSON.parse(responseJson)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).orderId).toBe('123')
  })

  it('returns 404 for unmatched route', async () => {
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const kernel = createHttpKernel({ router, middleware })

    const responseJson = await kernel(JSON.stringify({
      method: 'GET', path: '/nonexistent', query: '', headers: {}, body: '',
    }))

    const response = JSON.parse(responseJson)
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
    await kernel(JSON.stringify({
      method: 'GET', path: '/test', query: '', headers: {}, body: '',
    }))

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

    const responseJson = await kernel(JSON.stringify({
      method: 'GET', path: '/error', query: '', headers: {}, body: '',
    }))

    const response = JSON.parse(responseJson)
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
    await kernel(JSON.stringify({
      method: 'GET', path: '/test', query: '',
      headers: { 'x-request-id': 'req-abc-123' },
      body: '',
    }))

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

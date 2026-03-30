import { describe, expect, it } from 'vitest'
import { Context, MiddlewareRegistry, Router } from '../../src/index.js'

describe('router > basic routes', () => {
  it('registers and matches GET route', () => {
    const router = new Router()
    router.get('/orders', async () => {})
    expect(router.routeCount).toBe(1)
    expect(router.match('GET', '/orders')?.route.method).toBe('GET')
  })

  it('registers all HTTP methods including HEAD and OPTIONS', () => {
    const router = new Router()
    router.post('/a', async () => {})
    router.put('/b', async () => {})
    router.patch('/c', async () => {})
    router.delete('/d', async () => {})
    router.head('/e', async () => {})
    router.options('/f', async () => {})
    expect(router.routeCount).toBe(6)
  })

  it('matches :param and extracts params', () => {
    const router = new Router()
    router.get('/orders/:id', async () => {})
    expect(router.match('GET', '/orders/123')?.params.id).toBe('123')
  })

  it('extracts multiple params', () => {
    const router = new Router()
    router.get('/orders/:orderId/items/:itemId', async () => {})
    const result = router.match('GET', '/orders/abc/items/xyz')
    expect(result?.params.orderId).toBe('abc')
    expect(result?.params.itemId).toBe('xyz')
  })

  it('returns undefined for non-matching', () => {
    const router = new Router()
    router.get('/orders', async () => {})
    expect(router.match('POST', '/orders')).toBeUndefined()
    expect(router.match('GET', '/users')).toBeUndefined()
  })
})

describe('router > fluent chaining', () => {
  it('chains guard, validate, middleware', () => {
    const router = new Router()
    router.post('/orders', async () => {}).guard('jwt').validate('CreateOrderDTO').middleware('throttle')
    const result = router.match('POST', '/orders')
    expect(result?.route.guards).toContain('jwt')
    expect(result?.route.validators).toContain('CreateOrderDTO')
    expect(result?.route.middleware).toContain('throttle')
  })

  it('chains version and deprecation', () => {
    const router = new Router()
    router.get('/orders', async () => {}).version('1').deprecates('1', { sunset: '2027-01-01' })
    const result = router.match('GET', '/orders')
    expect(result?.route.version).toBe('1')
    expect(result?.route.deprecates?.sunset).toBe('2027-01-01')
  })
})

describe('router > groups', () => {
  it('applies prefix to group routes', () => {
    const router = new Router()
    router.group({ prefix: '/api/v1' }, (r) => {
      r.get('/orders', async () => {})
      r.post('/users', async () => {})
    })
    expect(router.routeCount).toBe(2)
    expect(router.match('GET', '/api/v1/orders')).toBeDefined()
    expect(router.match('POST', '/api/v1/users')).toBeDefined()
    expect(router.match('GET', '/orders')).toBeUndefined()
  })

  it('applies group middleware and guards', () => {
    const router = new Router()
    router.group({ middleware: ['auth'], guards: ['jwt'] }, (r) => {
      r.get('/protected', async () => {})
    })
    const result = router.match('GET', '/protected')
    expect(result?.route.middleware).toContain('auth')
    expect(result?.route.guards).toContain('jwt')
  })

  it('group middleware prepended to route middleware', () => {
    const router = new Router()
    router.group({ middleware: ['group-mw'] }, (r) => {
      r.get('/test', async () => {}).middleware('route-mw')
    })
    const result = router.match('GET', '/test')
    expect(result?.route.middleware).toEqual(['group-mw', 'route-mw'])
  })
})

describe('middleware > pipeline', () => {
  it('executes in onion order', async () => {
    const registry = new MiddlewareRegistry()
    const log: string[] = []
    registry.use(async (_ctx, next) => { log.push('1:in'); await next(); log.push('1:out') })
    registry.use(async (_ctx, next) => { log.push('2:in'); await next(); log.push('2:out') })

    const chain = registry.buildChain([], async () => { log.push('handler') })
    const ctx = Context.http('t', { method: 'GET', path: '/', query: '', headers: {}, body: '' })
    await chain(ctx, async () => {})
    expect(log).toEqual(['1:in', '2:in', 'handler', '2:out', '1:out'])
  })

  it('can short-circuit', async () => {
    const registry = new MiddlewareRegistry()
    registry.use(async (ctx) => { ctx.response!.status = 403 })
    let called = false
    const chain = registry.buildChain([], async () => { called = true })
    const ctx = Context.http('t', { method: 'GET', path: '/', query: '', headers: {}, body: '' })
    await chain(ctx, async () => {})
    expect(called).toBe(false)
    expect(ctx.response?.status).toBe(403)
  })

  it('works with HTTP and event contexts', async () => {
    const registry = new MiddlewareRegistry()
    const types: string[] = []
    registry.use(async (ctx, next) => { types.push(ctx.type); await next() })
    const chain = registry.buildChain([], async () => {})
    await chain(Context.http('1', { method: 'GET', path: '/', query: '', headers: {}, body: '' }), async () => {})
    await chain(Context.event('2', { name: 'test', data: '{}', correlationId: 'c' }), async () => {})
    expect(types).toEqual(['http', 'event'])
  })
})

import { describe, expect, it } from 'vitest'
import { HttpContext, MiddlewareRegistry, Router } from '../../src/index.js'

function makeCtx(): HttpContext {
  return new HttpContext('test', { method: 'GET', path: '/', query: '', headers: {}, body: '' }, {}, { pattern: '/', middleware: [] })
}

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

  it('supports any() for all methods', () => {
    const router = new Router()
    router.any('/catch-all', async () => {})
    expect(router.match('GET', '/catch-all')).toBeDefined()
    expect(router.match('POST', '/catch-all')).toBeDefined()
    expect(router.match('DELETE', '/catch-all')).toBeDefined()
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

  it('chains .as() for named routes', () => {
    const router = new Router()
    router.get('/users', async () => {}).as('users.index')
    expect(router.match('GET', '/users')?.route.name).toBe('users.index')
  })

  it('chains .where() for param matchers', () => {
    const router = new Router()
    router.get('/users/:id', async () => {}).where('id', router.matchers.number())
    expect(router.match('GET', '/users/42')).toBeDefined()
    expect(router.match('GET', '/users/abc')).toBeUndefined()
  })

  it('chains .where() with uuid matcher', () => {
    const router = new Router()
    router.get('/tasks/:id', async () => {}).where('id', router.matchers.uuid())
    expect(router.match('GET', '/tasks/550e8400-e29b-41d4-a716-446655440000')).toBeDefined()
    expect(router.match('GET', '/tasks/not-a-uuid')).toBeUndefined()
  })
})

describe('router > controller tuples', () => {
  it('registers controller action [Class, method]', () => {
    class UsersController { async index() {} }
    const router = new Router()
    router.get('/users', [UsersController, 'index'])
    const match = router.match('GET', '/users')
    expect(match?.route.controller?.target).toBe(UsersController)
    expect(match?.route.controller?.method).toBe('index')
    expect(match?.route.handler).toBeNull()
  })
})

describe('router > groups', () => {
  it('legacy: applies prefix to group routes', () => {
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

  it('legacy: applies group middleware and guards', () => {
    const router = new Router()
    router.group({ middleware: ['auth'], guards: ['jwt'] }, (r) => {
      r.get('/protected', async () => {})
    })
    const result = router.match('GET', '/protected')
    expect(result?.route.middleware).toContain('auth')
    expect(result?.route.guards).toContain('jwt')
  })

  it('legacy: group middleware prepended to route middleware', () => {
    const router = new Router()
    router.group({ middleware: ['group-mw'] }, (r) => {
      r.get('/test', async () => {}).middleware('route-mw')
    })
    const result = router.match('GET', '/test')
    expect(result?.route.middleware).toEqual(['group-mw', 'route-mw'])
  })

  it('AdonisJS-style: group(() => {}).prefix().middleware()', () => {
    const router = new Router()
    router.group(() => {
      router.get('/users', async () => {}).as('users.index')
      router.post('/users', async () => {}).as('users.store')
    })!.prefix('/api').middleware('auth').as('api')

    expect(router.match('GET', '/api/users')).toBeDefined()
    expect(router.match('POST', '/api/users')).toBeDefined()
    expect(router.match('GET', '/api/users')?.route.middleware).toContain('auth')
    expect(router.match('GET', '/api/users')?.route.name).toBe('api.users.index')
  })
})

describe('router > resource', () => {
  it('generates CRUD routes', () => {
    class PostsController {
      async index() {}
      async store() {}
      async show() {}
      async update() {}
      async destroy() {}
    }
    const router = new Router()
    router.resource('posts', PostsController)

    expect(router.match('GET', '/posts')?.route.controller?.method).toBe('index')
    expect(router.match('POST', '/posts')?.route.controller?.method).toBe('store')
    expect(router.match('GET', '/posts/1')?.route.controller?.method).toBe('show')
    expect(router.match('PUT', '/posts/1')?.route.controller?.method).toBe('update')
    expect(router.match('PATCH', '/posts/1')?.route.controller?.method).toBe('update')
    expect(router.match('DELETE', '/posts/1')?.route.controller?.method).toBe('destroy')
  })

  it('generates named routes', () => {
    class PostsController {}
    const router = new Router()
    router.resource('posts', PostsController)
    expect(router.match('GET', '/posts')?.route.name).toBe('posts.index')
    expect(router.match('POST', '/posts')?.route.name).toBe('posts.store')
  })
})

describe('router > makeUrl', () => {
  it('generates URL from named route', () => {
    const router = new Router()
    router.get('/users/:id', async () => {}).as('users.show')
    expect(router.makeUrl('users.show', { id: '42' })).toBe('/users/42')
  })

  it('throws on unknown route name', () => {
    const router = new Router()
    expect(() => router.makeUrl('nope')).toThrow("Route 'nope' not found")
  })
})

describe('middleware > pipeline', () => {
  it('executes in onion order', async () => {
    const registry = new MiddlewareRegistry()
    const log: string[] = []
    registry.use(async (_ctx, next) => { log.push('1:in'); await next(); log.push('1:out') })
    registry.use(async (_ctx, next) => { log.push('2:in'); await next(); log.push('2:out') })

    const chain = registry.buildChain([], [], async () => { log.push('handler') })
    const ctx = makeCtx()
    await chain(ctx, async () => {})
    expect(log).toEqual(['1:in', '2:in', 'handler', '2:out', '1:out'])
  })

  it('can short-circuit', async () => {
    const registry = new MiddlewareRegistry()
    registry.use(async (ctx) => { ctx.response.status(403) })
    let called = false
    const chain = registry.buildChain([], [], async () => { called = true })
    const ctx = makeCtx()
    await chain(ctx, async () => {})
    expect(called).toBe(false)
    expect(ctx.response.getStatus()).toBe(403)
  })

  it('inline middleware executes between named and handler', async () => {
    const registry = new MiddlewareRegistry()
    const log: string[] = []
    registry.register('named', async (_ctx, next) => { log.push('named'); await next() })
    const inlineMw = async (_ctx: HttpContext, next: () => Promise<void>) => { log.push('inline'); await next() }
    const chain = registry.buildChain(['named'], [inlineMw], async () => { log.push('handler') })
    await chain(makeCtx(), async () => {})
    expect(log).toEqual(['named', 'inline', 'handler'])
  })
})

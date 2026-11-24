/**
 * A middleware declared with `router.named({ auth })` is reachable by its name:
 * `route.middleware('auth')` and `group.middleware('auth')` run it, the
 * factory form `.use(middleware.auth(args))` hands it its arguments, and a name
 * nothing declares stops the application when it boots, not on a request.
 */
import { describe, expect, it } from 'vitest'
import type { HttpKernelRequest } from '../../src/HttpKernel.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import { createHttpKernel, errors, Ignitor, MiddlewareRegistry, Router } from '../../src/index.js'

const TOKEN = 'valid-token'

/**
 * The auth guide's middleware: it reads a bearer token and fills `ctx.auth`
 * the way warden's authenticator does, naming the guard that vouched.
 */
class AuthMiddleware {
  async handle(
    ctx: HttpContext,
    next: () => Promise<void>,
    options: { guards?: string[] } = {},
  ): Promise<void> {
    const bearer = ctx.request.header('authorization')
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined
    if (token !== TOKEN) {
      throw new errors.E_UNAUTHORIZED_ACCESS('Bearer token required')
    }
    ctx.auth = {
      isAuthenticated: true,
      authenticatedViaGuard: 'jwt',
      user: { id: 'u1', roles: ['admin'], permissions: [] },
    }
    ctx.store.set('guards', options.guards ?? null)
    await next()
  }
}

const authImport = async () => ({ default: AuthMiddleware })

function request(path: string, signedIn: boolean): HttpKernelRequest {
  return {
    method: 'GET',
    path,
    query: '',
    headers: {
      accept: 'application/json',
      ...(signedIn ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: '',
  }
}

function answer(ctx: HttpContext): void {
  ctx.response.json({
    user: ctx.auth?.user?.id ?? null,
    via: ctx.auth?.authenticatedViaGuard ?? null,
    guards: ctx.store.get('guards') ?? null,
  })
}

describe('named middleware > referenced by name', () => {
  it('protects a route: anonymous 401, signed in 200 through the jwt guard', async () => {
    const router = new Router()
    router.named({ auth: authImport })
    router.get('/dashboard', answer).middleware('auth').guard('jwt')
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })

    const anonymous = await kernel(request('/dashboard', false))
    expect(anonymous.status).toBe(401)
    expect(JSON.parse(anonymous.body)).toMatchObject({
      error: { code: 'E_UNAUTHORIZED_ACCESS' },
    })

    const signedIn = await kernel(request('/dashboard', true))
    expect(signedIn.status).toBe(200)
    expect(JSON.parse(signedIn.body)).toEqual({ user: 'u1', via: 'jwt', guards: null })
  })

  it('protects every route of a group, nested groups included', async () => {
    const router = new Router()
    router.named({ auth: authImport })
    router
      .group(() => {
        router.get('/admin/users', answer)
        router.group(() => {
          router.get('/admin/reports', answer)
        })
      })
      .middleware('auth')
      .guard('jwt')
      .role('admin')
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })

    for (const path of ['/admin/users', '/admin/reports']) {
      expect((await kernel(request(path, false))).status).toBe(401)
      const res = await kernel(request(path, true))
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ user: 'u1', via: 'jwt' })
    }
  })

  it('hands the factory arguments to handle(), on a route and on a group', async () => {
    const router = new Router()
    const middleware = router.named({ auth: authImport })
    router.get('/one', answer).use(middleware.auth({ guards: ['jwt'] }))
    router
      .group(() => {
        router.get('/two', answer)
      })
      .use(middleware.auth({ guards: ['web', 'jwt'] }))
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })

    expect(JSON.parse((await kernel(request('/one', true))).body)).toMatchObject({
      guards: ['jwt'],
    })
    expect(JSON.parse((await kernel(request('/two', true))).body)).toMatchObject({
      guards: ['web', 'jwt'],
    })
    expect((await kernel(request('/two', false))).status).toBe(401)
  })

  it('runs a name the registry holds before the router collection', async () => {
    const router = new Router()
    router.named({ tag: authImport })
    const registry = new MiddlewareRegistry()
    registry.register('tag', async (ctx, next) => {
      ctx.store.set('guards', ['registry'])
      await next()
    })
    router.get('/tagged', answer).middleware('tag')

    const res = await createHttpKernel({ router, middleware: registry })(request('/tagged', false))

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ guards: ['registry'] })
  })

  it('lets RPC and GraphQL find the router collection through the application registry', () => {
    const router = new Router()
    router.named({ auth: authImport })
    const registry = new MiddlewareRegistry(router)

    expect(registry.get('auth')).toBeDefined()
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.names()).toEqual(['auth'])
  })
})

/**
 * Warden's silent auth: puts an authenticator on `ctx.auth` that knows which
 * guard vouched for the request, and never refuses anybody.
 */
class SilentAuthMiddleware {
  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    const bearer = ctx.request.header('authorization')
    let via: string | undefined
    const auth = {
      get isAuthenticated() {
        return via !== undefined
      },
      get authenticatedViaGuard() {
        return via
      },
      get user() {
        return via === undefined ? undefined : { id: 'u1' }
      },
      async authenticateUsing(guards: string[] = ['jwt']) {
        if (bearer === `Bearer ${TOKEN}` && guards.includes('jwt')) {
          via = 'jwt'
          return { id: 'u1' }
        }
        throw new errors.E_UNAUTHORIZED_ACCESS('Unauthorized access')
      },
    }
    ctx.auth = auth
    await next()
  }
}

/** The web template's refusing `auth` middleware. */
class RefusingAuthMiddleware {
  async handle(
    ctx: HttpContext,
    next: () => Promise<void>,
    options: { guards?: string[] } = {},
  ): Promise<void> {
    const authenticate = ctx.auth?.authenticateUsing
    if (typeof authenticate !== 'function') {
      throw new errors.E_UNAUTHORIZED_ACCESS('Unauthorized access')
    }
    await authenticate.call(ctx.auth, options.guards)
    await next()
  }
}

describe('named middleware > after the router stack', () => {
  function kernelWith(declare: (router: Router) => void) {
    const router = new Router()
    router.use([async () => ({ default: SilentAuthMiddleware })])
    declare(router)
    return createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      routerMiddleware: router.getRouterMiddleware(),
    })
  }

  it('runs a named middleware after router.use(), which fills ctx.auth first', async () => {
    const kernel = kernelWith((router) => {
      const middleware = router.named({
        auth: async () => ({ default: RefusingAuthMiddleware }),
      })
      router.get('/by-name', answer).middleware('auth').guard('jwt')
      router.get('/by-factory', answer).use(middleware.auth({ guards: ['jwt'] }))
      router.get('/other-guard', answer).use(middleware.auth({ guards: ['web'] }))
    })

    for (const path of ['/by-name', '/by-factory']) {
      expect((await kernel(request(path, false))).status).toBe(401)
      const res = await kernel(request(path, true))
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ user: 'u1', via: 'jwt' })
    }
    expect((await kernel(request('/other-guard', true))).status).toBe(401)
  })
})

describe('named middleware > unknown name', () => {
  it('refuses to build the kernel, naming the route and the registered names', () => {
    const router = new Router()
    router.named({ auth: authImport })
    router.get('/dashboard', answer).middleware('authh')

    expect(() => createHttpKernel({ router, middleware: new MiddlewareRegistry() })).toThrow(
      expect.objectContaining({
        code: 'E_MIDDLEWARE_NOT_FOUND',
        message: expect.stringMatching(/GET \/dashboard.*'authh'.*Registered: auth/),
      }),
    )
  })

  it('stops an HTTP application at boot', async () => {
    const app = new Ignitor({
      serverFactory: () => ({
        onRequest() {},
        async listen() {},
        async port() {
          return 0
        },
        async close() {},
      }),
      gracefulShutdown: false,
    })
      .httpServer()
      .routes((router) => {
        router.named({ auth: authImport })
        router
          .group(() => {
            router.get('/admin', answer)
          })
          .middleware('admn')
      })

    await expect(app.start()).rejects.toMatchObject({ code: 'E_MIDDLEWARE_NOT_FOUND' })
    await app.stop().catch(() => {})
  })

  it('stops a toolkit kernel when it is first asked for', async () => {
    const app = await new Ignitor()
      .routes((router) => {
        router.get('/dashboard', answer).middleware('auth')
      })
      .start()

    expect(() => app.getKernel()).toThrow(
      expect.objectContaining({ code: 'E_MIDDLEWARE_NOT_FOUND' }),
    )
    await app.stop()
  })

  it('still refuses at request time a route added after the kernel was built', async () => {
    const router = new Router()
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })
    router.get('/late', answer).middleware('nope')

    const res = await kernel(request('/late', true))

    expect(res.status).toBe(500)
  })
})

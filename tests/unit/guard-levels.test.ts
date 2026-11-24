/**
 * Guard levels only restrict. A group's `.guard()` (chained or object form),
 * a nested group's, a second `.guard()` call and an `@Guard()` decorator each
 * add a level: the request must be authenticated by a guard EVERY level
 * names. A request is authenticated by one guard, so levels with no guard in
 * common accept nothing — they never let one guard satisfy one level and
 * another guard the next.
 */
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { createHttpKernel } from '../../src/HttpKernel.js'
import { type AuthState, HttpContext } from '../../src/http/HttpContext.js'
import { guardsOfEveryLevel } from '../../src/http/permissions.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'
import { OpenApiGenerator } from '../../src/openapi/OpenApiGenerator.js'
import { Router } from '../../src/router/Router.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'

interface Identity {
  /** The guard that authenticated the request. */
  via?: string
  /** Guards `authenticateUsing` can authenticate with; absent = no such method. */
  canAuthenticate?: string[]
}

/** What `authenticateUsing` was asked, per request. */
const asked: string[][] = []

function authFor(identity: Identity): AuthState {
  let via = identity.via
  const state: AuthState = {
    get isAuthenticated() {
      return via !== undefined
    },
    get user() {
      return via === undefined ? undefined : { id: 'u1' }
    },
  }
  Object.defineProperty(state, 'authenticatedViaGuard', { get: () => via })
  if (identity.canAuthenticate !== undefined) {
    const accepted = identity.canAuthenticate
    state.authenticateUsing = async (guards = []) => {
      asked.push(guards)
      const match = guards.find((guard) => accepted.includes(guard))
      if (match === undefined) {
        throw Object.assign(new Error('Unauthorized access'), { status: 401 })
      }
      via = match
      return { id: 'u1' }
    }
  }
  return state
}

async function status(router: Router, identity: Identity, path: string): Promise<number> {
  const kernel = createHttpKernel({
    router,
    container: new Container(),
    middleware: new MiddlewareRegistry(),
    serverMiddleware: [
      async (ctx, next) => {
        ctx.auth = authFor(identity)
        await next()
      },
    ],
  })
  const response = await kernel({
    method: 'GET',
    path,
    query: '',
    headers: { accept: 'application/json' },
    body: '',
  })
  return response.status
}

const ok = (ctx: HttpContext) => ctx.response.send('ran')

describe('guardsOfEveryLevel', () => {
  it('keeps the guards every level names, in the first level order', () => {
    expect(guardsOfEveryLevel([])).toEqual([])
    expect(guardsOfEveryLevel([['jwt', 'web']])).toEqual(['jwt', 'web'])
    expect(
      guardsOfEveryLevel([
        ['api', 'jwt', 'api'],
        ['jwt', 'api', 'web'],
      ]),
    ).toEqual(['api', 'jwt'])
    expect(guardsOfEveryLevel([['jwt'], ['web']])).toEqual([])
  })
})

describe('a route guard inside a group guard restricts, never widens', () => {
  /** The same route, declared with the chained group and with the object form. */
  function forms(): Router[] {
    const chained = new Router()
    chained
      .group(() => {
        chained.get('/api/me', ok).guard('web')
      })
      .guard('jwt')
    const object = new Router()
    object.group({ guards: ['jwt'] }, (r) => {
      r.get('/api/me', ok).guard('web')
    })
    return [chained, object]
  }

  it('refuses a session-only request, and a bearer-only one', async () => {
    for (const router of forms()) {
      expect(await status(router, { via: 'web' }, '/api/me')).toBe(401)
      expect(await status(router, { via: 'jwt' }, '/api/me')).toBe(401)
    }
  })

  it('does not authenticate the request once per level', async () => {
    asked.length = 0
    for (const router of forms()) {
      expect(await status(router, { canAuthenticate: ['jwt', 'web'] }, '/api/me')).toBe(401)
    }
    expect(asked).toEqual([])
  })

  it('records one level per declaration, the group first, in both forms', () => {
    for (const router of forms()) {
      expect(router.getRoutes().map((route) => route.guards)).toEqual([[['jwt'], ['web']]])
    }
  })
})

describe('levels that share a guard', () => {
  function shared(): Router {
    const router = new Router()
    router
      .group(() => {
        router.get('/api/me', ok).guard('jwt', 'web')
      })
      .guard('jwt')
    return router
  }

  it('accepts only the guard both levels name', async () => {
    expect(await status(shared(), { via: 'jwt' }, '/api/me')).toBe(200)
    expect(await status(shared(), { via: 'web' }, '/api/me')).toBe(401)
  })

  it('authenticates with the guards both levels name, and nothing else', async () => {
    asked.length = 0
    expect(await status(shared(), { canAuthenticate: ['web', 'jwt'] }, '/api/me')).toBe(200)
    expect(asked).toEqual([['jwt']])
  })

  it('still lets a single .guard() accept either of its guards', async () => {
    const router = new Router()
    router.get('/api/me', ok).guard('jwt', 'web')
    expect(await status(router, { via: 'web' }, '/api/me')).toBe(200)
    expect(await status(router, { via: 'jwt' }, '/api/me')).toBe(200)
    expect(await status(router, { via: 'api' }, '/api/me')).toBe(401)
  })

  it('makes a second .guard() call a level of its own', async () => {
    const router = new Router()
    router.get('/api/me', ok).guard('jwt', 'web').guard('web', 'api')
    expect(await status(router, { via: 'web' }, '/api/me')).toBe(200)
    expect(await status(router, { via: 'jwt' }, '/api/me')).toBe(401)
    expect(await status(router, { via: 'api' }, '/api/me')).toBe(401)
  })

  it('refuses a call that names no guard rather than adding an empty level', () => {
    const router = new Router()
    expect(() => router.get('/open', ok).guard()).toThrow(
      expect.objectContaining({ code: 'E_EMPTY_GATE_REQUIREMENT' }),
    )
    expect(() =>
      router
        .group(() => {
          router.get('/also-open', ok)
        })
        .guard(),
    ).toThrow(expect.objectContaining({ code: 'E_EMPTY_GATE_REQUIREMENT' }))
  })
})

describe('nested groups', () => {
  function nested(): Router {
    const router = new Router()
    router
      .group(() => {
        router.get('/api/outer', ok)
        router
          .group(() => {
            router.get('/api/inner', ok)
          })
          .guard('api', 'web')
      })
      .guard('jwt', 'api')
    return router
  }

  it('makes each nested level a requirement of its own', async () => {
    expect(await status(nested(), { via: 'api' }, '/api/inner')).toBe(200)
    expect(await status(nested(), { via: 'jwt' }, '/api/inner')).toBe(401)
    expect(await status(nested(), { via: 'web' }, '/api/inner')).toBe(401)
  })

  it('keeps the inner level off the outer routes', async () => {
    expect(await status(nested(), { via: 'jwt' }, '/api/outer')).toBe(200)
    expect(await status(nested(), { via: 'web' }, '/api/outer')).toBe(401)
  })
})

describe('the @Guard() decorator on the route gate', () => {
  /**
   * `@Guard()` of `@c9up/warden` stores its guards under this key, which the
   * kernel reads; written here directly because ream does not depend on warden.
   */
  const GUARD_KEY = Symbol.for('warden:guard')

  class AccountController {
    async show(ctx: HttpContext) {
      ctx.response.send('ran')
    }
  }
  Reflect.defineMetadata(GUARD_KEY, ['jwt', 'web'], AccountController.prototype, 'show')

  it("accepts either guard of @Guard('jwt', 'web'), as warden's middleware does", async () => {
    const router = new Router()
    router.get('/account', [AccountController, 'show'])
    expect(await status(router, { via: 'web' }, '/account')).toBe(200)
    expect(await status(router, { via: 'jwt' }, '/account')).toBe(200)
    expect(await status(router, { via: 'api' }, '/account')).toBe(401)
  })

  it('is a level on top of the route and group guards', async () => {
    const router = new Router()
    router
      .group(() => {
        router.get('/account', [AccountController, 'show'])
      })
      .guard('jwt')
    expect(await status(router, { via: 'jwt' }, '/account')).toBe(200)
    expect(await status(router, { via: 'web' }, '/account')).toBe(401)
  })
})

describe('RPC guard levels', () => {
  async function call(rpc: RpcRouter, identity: Identity): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'me.show', params: {}, id: 1 })
    const ctx = new HttpContext(
      'req-1',
      {
        method: 'POST',
        path: '/rpc',
        query: '',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      },
      {},
      { pattern: '/rpc', middleware: [] },
    )
    ctx.auth = authFor(identity)
    await rpc.handle(ctx)
    return JSON.parse(ctx.response.getBody())
  }

  const refused = { error: { code: -32003, message: 'Unauthorized' } }

  it('makes a method guard a level on top of its group guard', async () => {
    const rpc = new RpcRouter()
    rpc.group({ guards: ['jwt'] }, (r) => {
      r.method('me.show', () => 'me').guard('jwt', 'web')
    })
    expect(await call(rpc, { via: 'web' })).toMatchObject(refused)
    expect(await call(rpc, { via: 'jwt' })).toMatchObject({ result: 'me' })
  })

  it('keeps the enclosing group guards in a nested group', async () => {
    const rpc = new RpcRouter()
    rpc.group({ guard: 'jwt' }, (outer) => {
      outer.group({ guards: ['jwt', 'web'] }, (inner) => {
        inner.method('me.show', () => 'me')
      })
    })
    expect(await call(rpc, { via: 'web' })).toMatchObject(refused)
    expect(await call(rpc, { via: 'jwt' })).toMatchObject({ result: 'me' })
  })

  it('keeps the enclosing group middleware in a nested group', async () => {
    const rpc = new RpcRouter()
    rpc.group({ middleware: ['outer'] }, (outer) => {
      outer.group({ middleware: ['inner'] }, (inner) => {
        inner.method('me.show', () => 'me')
      })
      outer.method('other.show', () => 'other')
    })
    expect(rpc.getMethod('me.show')?.middleware).toEqual(['outer', 'inner'])
    expect(rpc.getMethod('other.show')?.middleware).toEqual(['outer'])
  })
})

describe('OpenAPI', () => {
  it('lists the guards every level accepts as the security alternatives', () => {
    const router = new Router()
    router
      .group(() => {
        router.get('/api/me', ok).guard('jwt', 'web')
      })
      .guard('jwt', 'api')
    const spec = new OpenApiGenerator(router, { title: 'API', version: '1.0.0' }).generate()
    expect(spec.paths['/api/me']?.get).toMatchObject({ security: [{ jwt: [] }] })
  })
})

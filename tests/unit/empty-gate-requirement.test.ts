/**
 * An empty requirement never opens a route. `.guard()`, `.role()` and
 * `.permission()` called with nothing — or with a list that came out of
 * configuration empty — and `group({ guards: [] })` read as a gate and used to
 * add none: the route stayed public, with no error. They throw
 * `E_EMPTY_GATE_REQUIREMENT` where they are declared, on routes, groups, RPC
 * methods and GraphQL resolvers alike.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HttpKernelRequest } from '../../src/HttpKernel.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import {
  Application,
  createHttpKernel,
  errors,
  GraphQLEngine,
  MiddlewareRegistry,
  Router,
} from '../../src/index.js'
import { RpcProvider } from '../../src/rpc/RpcProvider.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'

const ok = (ctx: HttpContext) => ctx.response.send('ran')
const none: string[] = [] // e.g. read from configuration, and empty

const anonymous = (path: string): HttpKernelRequest => ({
  method: 'GET',
  path,
  query: '',
  headers: { host: 'app.test', accept: 'application/json' },
  body: '',
})

function refusal(declare: () => unknown): { code?: string; message: string } {
  try {
    declare()
  } catch (error) {
    if (error instanceof errors.E_EMPTY_GATE_REQUIREMENT) {
      return { code: error.code, message: error.message }
    }
    throw error
  }
  throw new Error('nothing was thrown')
}

describe('an empty gate on a route', () => {
  it('is refused where the route is declared, naming the route and the call', () => {
    const router = new Router()
    expect(refusal(() => router.get('/admin', ok).guard())).toEqual({
      code: 'E_EMPTY_GATE_REQUIREMENT',
      message:
        'GET /admin: .guard() names nothing to require, so it would leave what it is meant to protect open to every request.',
    })
    expect(refusal(() => router.post('/admin', ok).role(...none)).message).toContain(
      'POST /admin: .role()',
    )
    expect(refusal(() => router.delete('/admin', ok).permission(...none)).message).toContain(
      'DELETE /admin: .permission()',
    )
  })

  it('is refused on a group, chained or as an object', () => {
    const router = new Router()
    const group = () =>
      router.group(() => {
        router.get('/c', ok)
        router.get('/d', ok)
      })
    expect(refusal(() => group().guard()).message).toContain(
      'route group (GET /c, GET /d): .guard()',
    )
    expect(refusal(() => group().role(...none)).message).toContain('.role()')
    expect(refusal(() => group().permission()).message).toContain('.permission()')

    const object = (config: { guards?: string[]; roles?: string[]; permissions?: string[] }) =>
      refusal(() =>
        new Router().group(config, (r) => {
          r.get('/e', ok)
        }),
      ).message
    expect(object({ guards: [] })).toContain('route group (GET /e): guards: []')
    expect(object({ roles: none })).toContain('roles: []')
    expect(object({ permissions: [] })).toContain('permissions: []')
    expect(object({ guards: ['jwt'], roles: [] })).toContain('roles: []')
  })

  it('leaves a route that declares no gate public, and a named one enforced', async () => {
    const router = new Router()
    router.get('/public', ok)
    router.group({ prefix: '/v1' }, (r) => {
      r.get('/public', ok)
    })
    router.get('/admin', ok).guard('jwt').role('admin').permission('users.read')
    router.group({ guards: ['jwt'], roles: ['admin'], permissions: ['users.read'] }, (r) => {
      r.get('/grouped', ok)
    })
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })
    expect((await kernel(anonymous('/public'))).status).toBe(200)
    expect((await kernel(anonymous('/v1/public'))).status).toBe(200)
    expect((await kernel(anonymous('/admin'))).status).toBe(401)
    expect((await kernel(anonymous('/grouped'))).status).toBe(401)
  })
})

describe('an empty gate in a controller decorator', () => {
  /** The metadata the auth package's `@Role(...roles)` writes, under its key. */
  const decorate =
    (key: string, value: unknown): MethodDecorator =>
    (target, propertyKey) => {
      Reflect.defineMetadata(Symbol.for(key), value, target, propertyKey)
    }

  class ReportsController {
    @decorate('warden:role', none)
    async exportAll(ctx: HttpContext): Promise<void> {
      ctx.response.send('ran')
    }

    @decorate('warden:permission', [])
    async purge(ctx: HttpContext): Promise<void> {
      ctx.response.send('ran')
    }

    @decorate('warden:guard', 'jwt')
    async mangled(ctx: HttpContext): Promise<void> {
      ctx.response.send('ran')
    }

    @decorate('warden:role', ['admin'])
    async admin(ctx: HttpContext): Promise<void> {
      ctx.response.send('ran')
    }
  }

  it('refuses every request to the action', async () => {
    const router = new Router()
    router.get('/export', [ReportsController, 'exportAll'])
    router.get('/purge', [ReportsController, 'purge'])
    router.get('/mangled', [ReportsController, 'mangled'])
    router.get('/admin', [ReportsController, 'admin'])
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })

    for (const path of ['/export', '/purge', '/mangled']) {
      // Every time: a refused pipeline is not cached as a public one.
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await kernel(anonymous(path))
        expect(response.status).toBe(500)
        expect(JSON.parse(response.body).error.code).toBe('E_EMPTY_GATE_REQUIREMENT')
      }
    }
    // A decorator that names a role is a requirement like any other.
    expect((await kernel(anonymous('/admin'))).status).toBe(401)
  })
})

describe('an empty gate on an RPC method', () => {
  it('is refused on the method builder and on a group', () => {
    const rpc = new RpcRouter()
    const method = () => rpc.method('admin.purge', () => true)
    expect(refusal(() => method().guard())).toEqual({
      code: 'E_EMPTY_GATE_REQUIREMENT',
      message:
        "RPC method 'admin.purge': .guard() names nothing to require, so it would leave what it is meant to protect open to every request.",
    })
    expect(refusal(() => method().role(...none)).message).toContain('.role()')
    expect(refusal(() => method().permission()).message).toContain('.permission()')
    expect(refusal(() => rpc.group({ guards: [] }, () => {})).message).toContain(
      'RPC group: guards: []',
    )
    // A guard named either way is a level.
    rpc.group({ guard: 'jwt', guards: [] }, (r) => {
      r.method('admin.list', () => [])
    })
  })

  it('is refused on the endpoint when config/rpc.ts gives an empty guards list', async () => {
    const app = new Application()
    app.container.singleton('router', () => new Router())
    app.config.set('rpc', { guards: [] })
    const provider = new RpcProvider(app)
    provider.register()
    await expect(provider.start()).rejects.toMatchObject({
      code: 'E_EMPTY_GATE_REQUIREMENT',
      message: expect.stringContaining('config/rpc.ts: guards: []'),
    })
  })
})

describe('an empty gate on a GraphQL resolver', () => {
  class Tasks {
    list(): string[] {
      return []
    }
  }

  function engine(): GraphQLEngine {
    const dir = mkdtempSync(join(tmpdir(), 'ream-gql-gate-'))
    const schemaPath = join(dir, 'schema.graphql')
    writeFileSync(schemaPath, 'type Query { tasks: [String] }')
    return new GraphQLEngine({ schemaPath })
  }

  it('is refused when the resolver is registered', () => {
    const register = (options: { guards?: string[]; roles?: string[]; permissions?: string[] }) =>
      refusal(() => engine().resolver('Query', 'tasks', Tasks, 'list', options))
    expect(register({ guards: [] })).toEqual({
      code: 'E_EMPTY_GATE_REQUIREMENT',
      message:
        "GraphQL resolver 'Query.tasks': guards: [] names nothing to require, so it would leave what it is meant to protect open to every request.",
    })
    expect(register({ roles: none }).message).toContain('roles: []')
    expect(register({ permissions: none }).message).toContain('permissions: []')
  })

  it('accepts a resolver with no option, and one whose single form names the gate', () => {
    const gql = engine()
    gql.resolver('Query', 'tasks', Tasks, 'list')
    gql.resolver('Query', 'tasks', Tasks, 'list', {
      guard: 'jwt',
      guards: [],
      role: 'a',
      roles: [],
    })
  })
})

/**
 * Role and permission gates only ever restrict. A group's `.role()` (chained
 * or object form), a nested group's, a second `.role()` call and an `@Role()`
 * decorator each add a requirement on top of the route's own: none of them
 * lets through a user the other levels refuse.
 */
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { createHttpKernel, type HttpKernelRequest } from '../../src/HttpKernel.js'
import type { AuthState, HttpContext } from '../../src/http/HttpContext.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'
import { Router } from '../../src/router/Router.js'

type Identity = Partial<Pick<AuthState, 'authenticatedViaGuard'>> & {
  roles?: string[]
  permissions?: string[]
}

function request(path: string): HttpKernelRequest {
  return { method: 'GET', path, query: '', headers: { accept: 'application/json' }, body: '' }
}

/** A kernel that signs every request in as `identity`, or leaves it anonymous. */
function kernelFor(router: Router, identity: Identity | null) {
  return createHttpKernel({
    router,
    container: new Container(),
    middleware: new MiddlewareRegistry(),
    serverMiddleware: [
      async (ctx: HttpContext, next: () => Promise<void>) => {
        if (identity !== null) {
          ctx.auth = {
            isAuthenticated: true,
            ...(identity.authenticatedViaGuard === undefined
              ? {}
              : { authenticatedViaGuard: identity.authenticatedViaGuard }),
            user: {
              id: 'u1',
              roles: identity.roles ?? [],
              permissions: identity.permissions ?? [],
            },
          }
        }
        await next()
      },
    ],
  })
}

const ok = (ctx: HttpContext) => ctx.response.send('ran')

async function statuses(
  router: Router,
  identity: Identity | null,
  paths: string[],
): Promise<number[]> {
  const kernel = kernelFor(router, identity)
  const result: number[] = []
  for (const path of paths) result.push((await kernel(request(path))).status)
  return result
}

async function status(router: Router, identity: Identity | null, path: string): Promise<number> {
  const [only] = await statuses(router, identity, [path])
  return only ?? 0
}

describe('GroupBuilder.role()', () => {
  function adminGroup(): Router {
    const router = new Router()
    router
      .group(() => {
        router.get('/admin/users', ok)
        router.get('/admin/stats', ok)
      })
      .role('admin')
    router.get('/public', ok)
    return router
  }

  it('refuses every route of the group to a user without the role', async () => {
    expect(
      await statuses(adminGroup(), { roles: ['editor'] }, ['/admin/users', '/admin/stats']),
    ).toEqual([403, 403])
  })

  it('refuses an anonymous request with 401', async () => {
    expect(await status(adminGroup(), null, '/admin/users')).toBe(401)
  })

  it('lets a user holding the role through, and leaves routes outside the group open', async () => {
    expect(
      await statuses(adminGroup(), { roles: ['admin'] }, ['/admin/users', '/admin/stats']),
    ).toEqual([200, 200])
    expect(await status(adminGroup(), null, '/public')).toBe(200)
  })

  it('accepts any one of the roles a single call names', async () => {
    const router = new Router()
    router
      .group(() => {
        router.get('/staff', ok)
      })
      .role('admin', 'owner')

    expect(await status(router, { roles: ['owner'] }, '/staff')).toBe(200)
    expect(await status(router, { roles: ['editor'] }, '/staff')).toBe(403)
  })
})

describe('a route role inside a group role restricts, never widens', () => {
  /** The same routes, declared with the chained group and with the object form. */
  function forms(): Array<[string, Router]> {
    const chained = new Router()
    chained
      .group(() => {
        chained.get('/admin/posts', ok).role('editor')
      })
      .role('admin')
    const object = new Router()
    object.group({ roles: ['admin'] }, (r) => {
      r.get('/admin/posts', ok).role('editor')
    })
    return [
      ['chained', chained],
      ['object', object],
    ]
  }

  it('refuses an editor who is not an admin', async () => {
    for (const [, router] of forms()) {
      expect(await status(router, { roles: ['editor'] }, '/admin/posts')).toBe(403)
    }
  })

  it('refuses an admin who is not an editor', async () => {
    for (const [, router] of forms()) {
      expect(await status(router, { roles: ['admin'] }, '/admin/posts')).toBe(403)
    }
  })

  it('lets a user holding both through', async () => {
    for (const [, router] of forms()) {
      expect(await status(router, { roles: ['admin', 'editor'] }, '/admin/posts')).toBe(200)
    }
  })

  it('records one requirement per level, the group first, in both forms', () => {
    for (const [, router] of forms()) {
      expect(router.getRoutes().map((route) => route.roles)).toEqual([[['admin'], ['editor']]])
    }
  })
})

describe('RouteBuilder.role() called twice', () => {
  it('needs one role of each call', async () => {
    const router = new Router()
    router.get('/reports', ok).role('admin', 'owner').role('auditor')

    expect(await status(router, { roles: ['owner'] }, '/reports')).toBe(403)
    expect(await status(router, { roles: ['auditor'] }, '/reports')).toBe(403)
    expect(await status(router, { roles: ['owner', 'auditor'] }, '/reports')).toBe(200)
  })

  it('refuses to be called with no role, rather than add no requirement', () => {
    const router = new Router()
    expect(() => router.get('/open', ok).role()).toThrow(
      expect.objectContaining({ code: 'E_EMPTY_GATE_REQUIREMENT' }),
    )
    expect(() =>
      router
        .group(() => {
          router.get('/also-open', ok)
        })
        .role(),
    ).toThrow(expect.objectContaining({ code: 'E_EMPTY_GATE_REQUIREMENT' }))
  })
})

describe('GroupBuilder.permission()', () => {
  function deleteGroup(): Router {
    const router = new Router()
    router
      .group(() => {
        router.get('/posts/purge', ok)
        router.get('/posts/archive', ok)
      })
      .permission('posts.delete')
    return router
  }

  it('refuses every route of the group to a user without the permission', async () => {
    expect(
      await statuses(deleteGroup(), { permissions: ['posts.read'] }, [
        '/posts/purge',
        '/posts/archive',
      ]),
    ).toEqual([403, 403])
  })

  it('lets a user holding the permission through', async () => {
    expect(
      await statuses(deleteGroup(), { permissions: ['posts.delete'] }, [
        '/posts/purge',
        '/posts/archive',
      ]),
    ).toEqual([200, 200])
  })

  it('requires the group permissions AND the route permissions, in both forms', async () => {
    const chained = new Router()
    chained
      .group(() => {
        chained.get('/posts/purge', ok).permission('posts.purge')
      })
      .permission('posts.delete')
    const object = new Router()
    object.group({ permissions: ['posts.delete'] }, (r) => {
      r.get('/posts/purge', ok).permission('posts.purge')
    })

    for (const router of [chained, object]) {
      expect(router.getRoutes().map((route) => route.permissions)).toEqual([
        ['posts.delete', 'posts.purge'],
      ])
      expect(await status(router, { permissions: ['posts.delete'] }, '/posts/purge')).toBe(403)
      expect(await status(router, { permissions: ['posts.purge'] }, '/posts/purge')).toBe(403)
      expect(
        await status(router, { permissions: ['posts.delete', 'posts.purge'] }, '/posts/purge'),
      ).toBe(200)
    }
  })
})

describe('nested groups', () => {
  /**
   * The outer `.role()` is chained after its callback ran, so it reaches the
   * routes of the inner groups and the routes declared before and after them.
   */
  function nested(): Router {
    const router = new Router()
    router
      .group(() => {
        router.get('/admin/before', ok)
        router
          .group(() => {
            router.get('/admin/billing', ok)
          })
          .permission('billing.read')
        router
          .group(() => {
            router.get('/admin/audit', ok)
          })
          .role('auditor')
        router.get('/admin/after', ok)
      })
      .role('admin')
    return router
  }

  it('gates the routes declared before and after the inner groups by the outer role', async () => {
    expect(
      await statuses(nested(), { roles: ['editor'] }, ['/admin/before', '/admin/after']),
    ).toEqual([403, 403])
    expect(
      await statuses(nested(), { roles: ['admin'] }, ['/admin/before', '/admin/after']),
    ).toEqual([200, 200])
  })

  it('gates an inner route by the outer role and the inner permission together', async () => {
    expect(await status(nested(), { roles: ['admin'] }, '/admin/billing')).toBe(403)
    expect(
      await status(
        nested(),
        { roles: ['editor'], permissions: ['billing.read'] },
        '/admin/billing',
      ),
    ).toBe(403)
    expect(
      await status(nested(), { roles: ['admin'], permissions: ['billing.read'] }, '/admin/billing'),
    ).toBe(200)
  })

  it('makes each nested role level a requirement of its own', async () => {
    expect(await status(nested(), { roles: ['auditor'] }, '/admin/audit')).toBe(403)
    expect(await status(nested(), { roles: ['admin'] }, '/admin/audit')).toBe(403)
    expect(await status(nested(), { roles: ['admin', 'auditor'] }, '/admin/audit')).toBe(200)
  })

  it('keeps the inner levels off the outer routes', () => {
    const levels = Object.fromEntries(
      nested()
        .getRoutes()
        .map((route) => [route.path, { roles: route.roles, permissions: route.permissions }]),
    )
    expect(levels).toEqual({
      '/admin/before': { roles: [['admin']], permissions: [] },
      '/admin/billing': { roles: [['admin']], permissions: ['billing.read'] },
      '/admin/audit': { roles: [['admin'], ['auditor']], permissions: [] },
      '/admin/after': { roles: [['admin']], permissions: [] },
    })
  })
})

describe('combined with .guard()', () => {
  function jwtAdmins(): Router {
    const router = new Router()
    router
      .group(() => {
        router.get('/api/admin', ok).role('editor')
      })
      .guard('jwt')
      .role('admin')
    return router
  }

  it('refuses a request authenticated by another guard, even with the roles', async () => {
    expect(
      await status(
        jwtAdmins(),
        { authenticatedViaGuard: 'web', roles: ['admin', 'editor'] },
        '/api/admin',
      ),
    ).toBe(401)
  })

  it('refuses a request authenticated by the guard but holding one level only', async () => {
    for (const roles of [['admin'], ['editor']]) {
      expect(await status(jwtAdmins(), { authenticatedViaGuard: 'jwt', roles }, '/api/admin')).toBe(
        403,
      )
    }
  })

  it('lets a request authenticated by the guard and meeting every level through', async () => {
    expect(
      await status(
        jwtAdmins(),
        { authenticatedViaGuard: 'jwt', roles: ['admin', 'editor'] },
        '/api/admin',
      ),
    ).toBe(200)
  })
})

describe('the @Role() decorator on the route gate', () => {
  /**
   * `@Role()` of `@c9up/warden` stores its roles under this key, which the
   * kernel reads; written here directly because ream does not depend on warden.
   */
  const ROLE_KEY = Symbol.for('warden:role')

  class ReportsController {
    async export(ctx: HttpContext) {
      ctx.response.send('ran')
    }
  }
  Reflect.defineMetadata(ROLE_KEY, ['a', 'b'], ReportsController.prototype, 'export')

  function reports(): Router {
    const router = new Router()
    router.get('/reports', [ReportsController, 'export'])
    router
      .group(() => {
        router.get('/admin/reports', [ReportsController, 'export'])
      })
      .role('admin')
    return router
  }

  it("requires every role of @Role('a', 'b'), as warden's middleware does", async () => {
    expect(await status(reports(), { roles: ['a'] }, '/reports')).toBe(403)
    expect(await status(reports(), { roles: ['b'] }, '/reports')).toBe(403)
    expect(await status(reports(), { roles: ['a', 'b'] }, '/reports')).toBe(200)
  })

  it('applies on top of the group role', async () => {
    expect(await status(reports(), { roles: ['a', 'b'] }, '/admin/reports')).toBe(403)
    expect(await status(reports(), { roles: ['admin'] }, '/admin/reports')).toBe(403)
    expect(await status(reports(), { roles: ['admin', 'a', 'b'] }, '/admin/reports')).toBe(200)
  })
})

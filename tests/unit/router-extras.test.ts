import { describe, expect, it } from 'vitest'
import { Router } from '../../src/router/Router.js'

describe('router.route(methods[]) — multi-verb (AdonisJS parity)', () => {
  it('registers one route for several verbs, configured together', () => {
    const router = new Router()
    router.route(['GET', 'POST'], '/x', async () => {}).as('x')
    expect(router.match('GET', '/x')?.route.name).toBe('x')
    expect(router.match('POST', '/x')?.route.name).toBe('x')
    expect(router.match('DELETE', '/x')).toBeUndefined()
  })
})

describe('group.as() throws on an unnamed child (AdonisJS parity)', () => {
  it('rejects a group name when a route has no name', () => {
    const router = new Router()
    expect(() => {
      router
        .group(() => {
          router.get('/a', async () => {})
        })
        .as('grp')
    }).toThrow(/E_MISSING_ROUTE_NAME/)
  })

  it('prefixes names when every route is named', () => {
    const router = new Router()
    router
      .group(() => {
        router.get('/b', async () => {}).as('b')
      })
      .as('grp')
    expect(router.match('GET', '/b')?.route.name).toBe('grp.b')
  })
})

describe('router.generateTypes()', () => {
  it('emits a RouteName union and a RouteParams map from patterns', () => {
    const router = new Router()
    router.get('/users/:id', async () => {}).as('users.show')
    router.get('/posts', async () => {}).as('posts.index')

    const types = router.generateTypes()
    expect(types).toContain('export type RouteName')
    expect(types).toContain('"users.show"')
    expect(types).toContain('"id": string')
    expect(types).toContain('"posts.index": Record<string, never>')
  })

  it('handles the empty router', () => {
    expect(new Router().generateTypes()).toContain('export type RouteName = never')
  })
})

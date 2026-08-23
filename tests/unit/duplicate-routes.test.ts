/**
 * A duplicate registration silently overwrote the earlier one — which is how an
 * authenticated endpoint gets shadowed by a later, unguarded route on the same
 * path, with nothing in the logs. AdonisJS throws on both a duplicate pattern
 * and a duplicate name; so does this.
 */
import { describe, expect, it } from 'vitest'
import { Router } from '../../src/router/Router.js'

const handler = () => 'ok'

describe('ream > duplicate routes', () => {
  it('refuses the same method and path twice', () => {
    const router = new Router()
    router.get('/admin', handler)
    router.get('/admin', handler)
    expect(() => router.match('GET', '/admin')).toThrow(/Duplicate route found/)
  })

  it('still allows the same path on different verbs', () => {
    const router = new Router()
    router.get('/posts', handler)
    router.post('/posts', handler)
    expect(router.match('GET', '/posts')).toBeDefined()
    expect(router.match('POST', '/posts')).toBeDefined()
  })

  it('refuses one name used for two different paths', () => {
    const router = new Router()
    router.get('/a', handler).as('thing')
    router.get('/b', handler).as('thing')
    expect(() => router.match('GET', '/a')).toThrow(/already exists/)
  })

  it('allows one name across the verbs of a single route', () => {
    const router = new Router()
    router.route(['PUT', 'PATCH'], '/posts/:id', handler).as('posts.update')
    expect(router.match('PUT', '/posts/1')).toBeDefined()
    expect(router.match('PATCH', '/posts/1')).toBeDefined()
    expect(router.urlFor('posts.update', { id: '1' })).toBe('/posts/1')
  })
})

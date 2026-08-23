/**
 * AdonisJS merges matchers as `{ ...global, ...local }`, so a route's own
 * matcher REPLACES the global one for that param. ream applied both as
 * separate gates, which meant the global always had the final say and a route
 * could never loosen it.
 */
import { describe, expect, it } from 'vitest'
import { Router } from '../../src/router/Router.js'

const handler = () => 'ok'

describe('ream > matcher precedence', () => {
  it('lets a route override the global matcher for that param', () => {
    const router = new Router()
    router.where('id', /^[0-9]+$/)
    router.get('/posts/:id', handler).where('id', /^[a-z-]+$/)
    // A slug, refused by the global matcher, accepted by the route's own.
    expect(router.match('GET', '/posts/hello-world')).toBeDefined()
  })

  it('still applies the global matcher where the route sets none', () => {
    const router = new Router()
    router.where('id', /^[0-9]+$/)
    router.get('/posts/:id', handler)
    expect(router.match('GET', '/posts/42')).toBeDefined()
    expect(router.match('GET', '/posts/abc')).toBeUndefined()
  })

  it('leaves other params under the global matcher', () => {
    const router = new Router()
    router.where('id', /^[0-9]+$/)
    router.get('/a/:id/b/:slug', handler).where('slug', /^[a-z]+$/)
    expect(router.match('GET', '/a/42/b/hello')).toBeDefined()
    // `id` is still numeric-only — overriding `slug` did not clear it.
    expect(router.match('GET', '/a/xx/b/hello')).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { Router } from '../../src/router/Router.js'

class PostsController {
  async index() {}
  async create() {}
  async store() {}
  async show() {}
  async edit() {}
  async update() {}
  async destroy() {}
}

describe('router > resource (AdonisJS RouteResource parity)', () => {
  it('generates the seven RESTful routes incl. create + edit', () => {
    const router = new Router()
    router.resource('posts', PostsController)

    expect(router.match('GET', '/posts')?.route.controller?.method).toBe('index')
    expect(router.match('GET', '/posts/create')?.route.controller?.method).toBe('create')
    expect(router.match('POST', '/posts')?.route.controller?.method).toBe('store')
    expect(router.match('GET', '/posts/1')?.route.controller?.method).toBe('show')
    expect(router.match('GET', '/posts/1/edit')?.route.controller?.method).toBe('edit')
    expect(router.match('PUT', '/posts/1')?.route.controller?.method).toBe('update')
    expect(router.match('PATCH', '/posts/1')?.route.controller?.method).toBe('update')
    expect(router.match('DELETE', '/posts/1')?.route.controller?.method).toBe('destroy')
  })

  it('names routes with the snake_cased base', () => {
    const router = new Router()
    router.resource('posts', PostsController)
    expect(router.match('GET', '/posts')?.route.name).toBe('posts.index')
    expect(router.match('GET', '/posts/create')?.route.name).toBe('posts.create')
    expect(router.match('GET', '/posts/1/edit')?.route.name).toBe('posts.edit')
  })

  it('apiOnly() drops create + edit', () => {
    const router = new Router()
    router.resource('posts', PostsController).apiOnly()
    // The form routes are gone from the table…
    expect(router.find('posts.create')).toBeNull()
    expect(router.find('posts.edit')).toBeNull()
    // …and /posts/:id/edit no longer resolves (no other 3-segment route).
    expect(router.match('GET', '/posts/1/edit')).toBeUndefined()
    // Note: GET /posts/create still matches `show` with id="create" — the
    // dynamic member route shadows the removed static one (AdonisJS-identical).
    expect(router.match('GET', '/posts')?.route.controller?.method).toBe('index')
    expect(router.match('POST', '/posts')?.route.controller?.method).toBe('store')
  })

  it('only() keeps just the named actions', () => {
    const router = new Router()
    router.resource('posts', PostsController).only(['index', 'show'])
    expect(router.match('GET', '/posts')?.route.controller?.method).toBe('index')
    expect(router.match('GET', '/posts/1')?.route.controller?.method).toBe('show')
    expect(router.match('POST', '/posts')).toBeUndefined()
    expect(router.match('DELETE', '/posts/1')).toBeUndefined()
  })

  it('except() removes the named actions', () => {
    const router = new Router()
    router.resource('posts', PostsController).except(['destroy'])
    expect(router.match('DELETE', '/posts/1')).toBeUndefined()
    expect(router.match('GET', '/posts')?.route.controller?.method).toBe('index')
  })

  it('deleted routes are excluded from getRoutes()', () => {
    const router = new Router()
    router.resource('posts', PostsController).only(['index'])
    const names = router.getRoutes().map((r) => r.name)
    expect(names).toContain('posts.index')
    expect(names).not.toContain('posts.destroy')
  })

  it('params() renames the id param', () => {
    const router = new Router()
    router.resource('posts', PostsController).params({ posts: 'slug' })
    // The member routes now bind :slug — matched value lands under `slug`.
    const matched = router.match('GET', '/posts/hello-world')
    expect(matched?.route.controller?.method).toBe('show')
    expect(matched?.params.slug).toBe('hello-world')
  })

  it('tap(action, cb) configures a single action route', () => {
    const router = new Router()
    router.resource('posts', PostsController).tap('index', (route) => route.as('posts.list'))
    expect(router.match('GET', '/posts')?.route.name).toBe('posts.list')
  })

  it('where() constrains a param via a string matcher (anchored)', () => {
    const router = new Router()
    router.resource('posts', PostsController).where('id', '[0-9]+')
    expect(router.match('GET', '/posts/42')?.route.controller?.method).toBe('show')
    // Non-numeric id must NOT match show (string matcher is anchored).
    expect(router.match('GET', '/posts/abc')).toBeUndefined()
  })
})

describe('router > nested + shallow resources', () => {
  it('nests with dot-notation and singularized parent param', () => {
    const router = new Router()
    router.resource('posts.comments', PostsController)
    const matched = router.match('GET', '/posts/7/comments/3')
    expect(matched?.route.controller?.method).toBe('show')
    expect(matched?.params.post_id).toBe('7')
    expect(matched?.params.id).toBe('3')
    expect(router.match('GET', '/posts/7/comments')?.route.name).toBe('posts.comments.index')
  })

  it('singularizes an irregular parent, not just a regular one', () => {
    // `people` → `person_id`. A regular-plurals-only inflector produced
    // `people_id`, and the route silently exposed the wrong param name.
    const router = new Router()
    router.resource('people.photos', PostsController)
    const matched = router.match('GET', '/people/7/photos/3')
    expect(matched?.params.person_id).toBe('7')
    expect(matched?.params.id).toBe('3')
  })

  it('leaves an uncountable parent alone', () => {
    const router = new Router()
    router.resource('sheep.tags', PostsController)
    expect(router.match('GET', '/sheep/7/tags/3')?.params.sheep_id).toBe('7')
  })

  it('shallowResource drops the parent prefix on member routes', () => {
    const router = new Router()
    router.shallowResource('posts.comments', PostsController)
    // Collection keeps the parent prefix…
    expect(router.match('GET', '/posts/7/comments')?.route.controller?.method).toBe('index')
    // …member routes are shallow.
    const show = router.match('GET', '/comments/3')
    expect(show?.route.controller?.method).toBe('show')
    expect(show?.params.id).toBe('3')
  })
})

describe('router > find / findOrFail / has', () => {
  it('finds a route by name and by pattern', () => {
    const router = new Router()
    router.get('/users/:id', async () => {}).as('users.show')
    expect(router.find('users.show')?.path).toBe('/users/:id')
    expect(router.find('/users/:id')?.name).toBe('users.show')
    expect(router.find('nope')).toBeNull()
  })

  it('has() reflects existence, findOrFail throws when absent', () => {
    const router = new Router()
    router.get('/x', async () => {}).as('x')
    expect(router.has('x')).toBe(true)
    expect(router.has('y')).toBe(false)
    expect(() => router.findOrFail('y')).toThrow(/Cannot find route/)
  })
})

describe('router > brisk redirect (AdonisJS semantics)', () => {
  it('on().redirect(name) targets a NAMED route', () => {
    const router = new Router()
    router.get('/dashboard', async () => {}).as('dashboard')
    router.on('/home').redirect('dashboard')
    // The brisk route is registered as a GET handler on /home.
    expect(router.match('GET', '/home')?.route.controller).toBeUndefined()
    expect(router.match('GET', '/home')).toBeDefined()
  })

  it('on().redirectToPath(url) targets a fixed path', () => {
    const router = new Router()
    router.on('/old').redirectToPath('/new')
    expect(router.match('GET', '/old')).toBeDefined()
  })
})

import { describe, expect, it } from 'vitest'
import { Router } from '../../src/router/Router.js'

class UsersController {
  async index() {}
  async show() {}
}

describe('router > controller registry + string handler reference', () => {
  it('resolves a "Controller.method" string ref against the registry', () => {
    const router = new Router()
    router.controllers({ UsersController: async () => ({ default: UsersController }) })
    router.get('/users', 'UsersController.index')

    const matched = router.match('GET', '/users')
    expect(matched?.route.lazyController?.method).toBe('index')
  })

  it('splits on the last dot so method resolves correctly', () => {
    const router = new Router()
    router.controllers({ UsersController: async () => ({ default: UsersController }) })
    router.get('/users/:id', 'UsersController.show')
    expect(router.match('GET', '/users/1')?.route.lazyController?.method).toBe('show')
  })

  it('throws at index build when the referenced controller is unregistered', () => {
    const router = new Router()
    router.get('/users', 'GhostController.index')
    expect(() => router.match('GET', '/users')).toThrow(/E_UNREGISTERED_CONTROLLER/)
  })

  it('rejects a malformed reference (no method) at registration', () => {
    const router = new Router()
    expect(() => router.get('/x', 'NoMethod')).toThrow(/Invalid controller reference/)
    expect(() => router.get('/y', 'Trailing.')).toThrow(/Invalid controller reference/)
  })
})

describe('router > lazy-import controller tuple', () => {
  it('accepts [() => import(...), "method"] and stores it as a lazy controller', () => {
    const router = new Router()
    router.get('/users', [async () => ({ default: UsersController }), 'index'])
    expect(router.match('GET', '/users')?.route.lazyController?.method).toBe('index')
  })

  it('still treats [Class, "method"] as an eager controller tuple', () => {
    const router = new Router()
    router.get('/users', [UsersController, 'show'])
    const matched = router.match('GET', '/users')
    expect(matched?.route.controller?.method).toBe('show')
    expect(matched?.route.lazyController).toBeUndefined()
  })
})

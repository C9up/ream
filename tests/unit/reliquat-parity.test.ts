import { describe, expect, it } from 'vitest'
import { configProvider } from '../../src/ConfigLoader.js'
import { Exception, InvalidArgumentsException, RuntimeException } from '../../src/http/Exception.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import { type RawRequest, Request } from '../../src/http/Request.js'
import { Router } from '../../src/router/Router.js'

describe('RouteBuilder.prefix (route-level)', () => {
  it('prepends a prefix to a single route', () => {
    const router = new Router()
    router.get('/users', async () => {}).prefix('/api')
    expect(router.match('GET', '/api/users')).toBeDefined()
    expect(router.match('GET', '/users')).toBeUndefined()
  })
})

describe('HttpContext ambient helpers', () => {
  const raw: RawRequest = {
    method: 'GET',
    path: '/u/1',
    query: '',
    headers: { host: 'api.example.com' },
    body: '',
  }
  const makeCtx = () =>
    new HttpContext('id', raw, { id: '1' }, { pattern: '/u/:id', middleware: [] })

  it('exposes ctx.subdomains and ctx.routeKey', () => {
    const ctx = makeCtx()
    expect(ctx.subdomains).toEqual(['api'])
    expect(ctx.routeKey).toBe('GET-/u/:id')
  })

  it('runOutsideContext clears the ambient context', () => {
    const ctx = makeCtx()
    HttpContext.run(ctx, () => {
      expect(HttpContext.get()).toBe(ctx)
      HttpContext.runOutsideContext(() => {
        expect(HttpContext.get()).toBeUndefined()
      })
      expect(HttpContext.get()).toBe(ctx)
    })
  })
})

describe('RuntimeException / InvalidArgumentsException', () => {
  it('are Exception subclasses with the right codes', () => {
    const runtime = new RuntimeException('boom')
    expect(runtime).toBeInstanceOf(Exception)
    expect(runtime.code).toBe('E_RUNTIME_EXCEPTION')
    expect(runtime.status).toBe(500)

    const invalid = new InvalidArgumentsException('bad arg')
    expect(invalid).toBeInstanceOf(RuntimeException)
    expect(invalid.code).toBe('E_INVALID_ARGUMENTS')
  })
})

describe('Request.original', () => {
  it('captures the first input and stays fixed across body mutation', () => {
    const req = new Request({
      method: 'POST',
      path: '/',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
    expect(req.all()).toEqual({ a: 1 })
    req.setParsedBody({ a: 2, b: 3 })
    expect(req.all()).toEqual({ a: 2, b: 3 })
    // original() reflects the first-seen input, not the mutated body.
    expect(req.original()).toEqual({ a: 1 })
  })
})

describe('configProvider (deferred config)', () => {
  it('resolves a provider against the app and passes plain values through', async () => {
    const app = { name: 'test-app' }
    const provider = configProvider.create((a) => ({ resolved: true, app: a }))
    expect(await configProvider.resolve(app, provider)).toEqual({ resolved: true, app })
    expect(await configProvider.resolve(app, { plain: 1 })).toEqual({ plain: 1 })
  })
})

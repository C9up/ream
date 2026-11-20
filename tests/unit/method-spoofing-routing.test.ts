/**
 * `allowMethodSpoofing` only changed what `request.method()` returned AFTER
 * the route was matched with the wire method, so `POST /posts/1?_method=DELETE`
 * answered 404 instead of running the DELETE route. AdonisJS
 * (`@adonisjs/http-server` 9.3.1 `routeFinder`) matches with
 * `ctx.request.method()`, which reads `_method` from the query string on a POST.
 */
import { describe, expect, it } from 'vitest'
import { createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'

function kernelFor(allowMethodSpoofing: boolean | undefined) {
  const router = new Router()
  router.delete('/posts/:id', (ctx) => {
    ctx.response.json({ ran: 'delete', method: ctx.request.method(), id: ctx.params.id })
  })
  router.post('/posts/:id', (ctx) => {
    ctx.response.json({ ran: 'post' })
  })
  return createHttpKernel({ router, middleware: new MiddlewareRegistry(), allowMethodSpoofing })
}

function post(query: string) {
  return {
    method: 'POST',
    path: '/posts/1',
    query,
    headers: { accept: 'application/json', host: 'app.test' },
    body: '',
  }
}

describe('method spoofing > routing', () => {
  it('routes a POST carrying _method=DELETE to the DELETE route when enabled', async () => {
    const res = await kernelFor(true)(post('_method=DELETE'))

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ran: 'delete', method: 'DELETE', id: '1' })
  })

  it('accepts a lower-case _method', async () => {
    const res = await kernelFor(true)(post('_method=delete'))

    expect(JSON.parse(res.body)).toMatchObject({ ran: 'delete' })
  })

  it('keeps routing on the wire method when disabled', async () => {
    for (const setting of [false, undefined]) {
      const res = await kernelFor(setting)(post('_method=DELETE'))
      expect(JSON.parse(res.body)).toEqual({ ran: 'post' })
    }
  })

  it('answers 404 for a spoofed method no route serves, naming that method', async () => {
    const res = await kernelFor(true)(post('_method=PATCH'))

    expect(res.status).toBe(404)
    expect(res.body).toContain('PATCH')
  })

  it('never spoofs a request that is not a POST', async () => {
    const router = new Router()
    router.get('/posts/:id', (ctx) => {
      ctx.response.json({ ran: 'get' })
    })
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      allowMethodSpoofing: true,
    })
    const res = await kernel({ ...post('_method=DELETE'), method: 'GET' })

    expect(JSON.parse(res.body)).toEqual({ ran: 'get' })
  })
})

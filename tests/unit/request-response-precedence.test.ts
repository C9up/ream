/**
 * Three precedence/shape rules that diverged from AdonisJS silently — each one
 * compiles either way and only shows up as wrong data or a missing redirect.
 */

import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'
import { Response } from '../../src/http/Response.js'

function request(query: string, body = '', headers: Record<string, string> = {}): Request {
  return new Request({ method: 'POST', path: '/orders', query, headers, body })
}

describe('Request > the query string wins over the body', () => {
  it('reads the query value for a key present in both', () => {
    // AdonisJS: `#requestData = { ...#requestBody, ...#requestQs }`.
    const r = request('id=1', JSON.stringify({ id: 2 }), {
      'content-type': 'application/json',
    })

    expect(r.all().id).toBe('1')
    expect(r.input('id')).toBe('1')
  })

  it('still merges the keys each side has alone', () => {
    const r = request('page=2', JSON.stringify({ name: 'x' }), {
      'content-type': 'application/json',
    })

    expect(r.all()).toMatchObject({ page: '2', name: 'x' })
  })
})

describe('Request > url() is the pathname', () => {
  it('omits the query string by default, as AdonisJS does', () => {
    expect(request('a=1&b=2').url()).toBe('/orders')
  })

  it('includes it when asked', () => {
    expect(request('a=1&b=2').url(true)).toBe('/orders?a=1&b=2')
  })
})

describe('Response > redirect(path) redirects', () => {
  function redirecting() {
    const response = new Response()
    const calls: Array<{ path?: string; status?: number; qs?: boolean }> = []
    response.setRedirectFactory(() => {
      const record: { path?: string; status?: number; qs?: boolean } = {}
      calls.push(record)
      const builder = {
        status(code: number) {
          record.status = code
          return builder
        },
        withQs() {
          record.qs = true
          return builder
        },
        toPath(path: string) {
          record.path = path
        },
        back() {
          record.path = 'back'
        },
      }
      return builder as never
    })
    return { response, calls }
  }

  it('redirects immediately when given a path', () => {
    const { response, calls } = redirecting()

    const returned = response.redirect('/login')

    expect(returned).toBeUndefined()
    expect(calls[0]).toMatchObject({ path: '/login', status: 302 })
  })

  it('honours the status and the query-forwarding flag', () => {
    const { response, calls } = redirecting()

    response.redirect('/login', true, 301)

    expect(calls[0]).toMatchObject({ path: '/login', status: 301, qs: true })
  })

  it("sends 'back' to the referrer", () => {
    const { response, calls } = redirecting()

    response.redirect('back')

    expect(calls[0]?.path).toBe('back')
  })

  it('still hands back the builder with no argument', () => {
    const { response } = redirecting()

    expect(response.redirect()).toBeDefined()
  })
})

describe('HttpKernel > an error is reported before it is handled', () => {
  it('reports even when handle() throws', async () => {
    // AdonisJS awaits `report` before `handle`. Handling first meant a throwing
    // handler swallowed the report: the error left no trace in the logs.
    const { createHttpKernel, MiddlewareRegistry, Router } = await import('../../src/index.js')
    const reported: unknown[] = []
    const router = new Router()
    router.get('/boom', () => {
      throw new Error('boom')
    })
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      exceptionHandler: {
        async report(error: unknown) {
          reported.push(error)
        },
        async handle() {
          throw new Error('the handler itself failed')
        },
      } as never,
    })

    const res = await kernel({
      method: 'GET',
      path: '/boom',
      query: '',
      headers: {},
      body: '',
    })

    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('boom')
    expect(res.status).toBe(500)
  })
})

describe('Router > matchers cast the param', () => {
  it('hands the handler a number, not a string', async () => {
    const { Router, matchers } = await import('../../src/index.js')
    const router = new Router()
    router.get('/orders/:id', async () => {}).where('id', matchers.number())

    const match = router.match('GET', '/orders/42')

    expect(match?.params.id).toBe(42)
  })

  it('lowercases a uuid, so a key built from it is stable', async () => {
    const { Router, matchers } = await import('../../src/index.js')
    const router = new Router()
    router.get('/u/:id', async () => {}).where('id', matchers.uuid())
    const upper = '3F2504E0-4F89-41D3-9A0C-0305E82C3301'

    expect(router.match('GET', `/u/${upper}`)?.params.id).toBe(upper.toLowerCase())
  })

  it('leaves a param alone when its matcher has no cast', async () => {
    const { Router, matchers } = await import('../../src/index.js')
    const router = new Router()
    router.get('/p/:slug', async () => {}).where('slug', matchers.slug())

    expect(router.match('GET', '/p/hello-world')?.params.slug).toBe('hello-world')
  })

  it('still refuses a param the matcher rejects', async () => {
    const { Router, matchers } = await import('../../src/index.js')
    const router = new Router()
    router.get('/orders/:id', async () => {}).where('id', matchers.number())

    // No route matched — `match()` reports it as absent.
    expect(router.match('GET', '/orders/abc')).toBeFalsy()
  })

  it('takes route(pattern, methods, handler), the AdonisJS order', async () => {
    const { Router } = await import('../../src/index.js')
    const router = new Router()
    router.route('/things', ['GET', 'POST'], async () => {})

    expect(router.match('GET', '/things')).toBeTruthy()
    expect(router.match('POST', '/things')).toBeTruthy()
  })
})

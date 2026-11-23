/**
 * The kernel turns an error into a response at the layer that threw, as
 * upstream's middleware runner does with its error handler: every outer
 * middleware sees its `next()` resolve and runs the code after it. Before,
 * the error unwound the whole pipeline first, so the session middleware never
 * committed and whatever an error's `handle()` flashed was lost.
 */
import { Exception } from '@c9up/flare'
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { createHttpKernel, type HttpKernelRequest } from '../../src/HttpKernel.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'
import { Router } from '../../src/router/Router.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

/** An error that answers itself the way a CSRF or credentials refusal does. */
class FlashingRefusal extends Exception {
  static override status = 400
  static override code = 'E_TEST_FLASHING_REFUSAL'

  handle(_error: this, ctx: HttpContext): void {
    ctx.session?.flash('error', 'Try again')
    ctx.response.redirect('/form')
  }
}

function get(path: string, cookie?: string): HttpKernelRequest {
  return { method: 'GET', path, query: '', headers: cookie ? { cookie } : {}, body: '' }
}

function sessionCookie(headers: Record<string, unknown>): string | undefined {
  const raw = headers['set-cookie']
  const lines = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split('\n')
  return lines
    .map((line) => line.split(';')[0] ?? '')
    .find((pair) => pair.startsWith('ream_session='))
}

describe('kernel > an error is answered where it is thrown', () => {
  it('runs the code after `await next()` of the middleware around the throw', async () => {
    const seen: string[] = []
    const router = new Router()
    router.get('/boom', () => {
      throw new Exception('nope', { status: 418, code: 'E_TEST_BOOM' })
    })
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [
        async (ctx, next) => {
          await next()
          seen.push(`after next: ${ctx.response.getStatus()}`)
          ctx.response.header('x-outer', 'ran')
        },
      ],
    })

    const response = await kernel({ ...get('/boom'), headers: { accept: 'application/json' } })

    // The handler's answer was already written when the outer layer resumed.
    expect(seen).toEqual(['after next: 418'])
    expect(response.status).toBe(418)
    expect(response.headers['x-outer']).toBe('ran')
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'E_TEST_BOOM', message: 'nope' },
    })
  })

  it('commits the session, so what an error flashes reaches the next request', async () => {
    const signer = new CookieSigner('test-app-key-32-bytes-long-xxxxxx')
    const container = new Container()
    container.singleton('encryption', () => signer)
    const session = new SessionMiddleware({
      store: 'memory',
      cookieName: 'ream_session',
      maxAge: 3600,
    })
    const router = new Router()
    router.get('/submit', () => {
      throw new FlashingRefusal()
    })
    router.get('/form', (ctx: HttpContext) => {
      ctx.response.send(String(ctx.session?.flashMessages.get('error') ?? 'none'))
    })
    const kernel = createHttpKernel({
      router,
      container,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [(ctx, next) => session.handle(ctx, next)],
    })

    const refused = await kernel(get('/submit'))
    expect(refused.status).toBe(302)
    const cookie = sessionCookie(refused.headers)
    expect(cookie).toBeDefined()

    const form = await kernel(get('/form', cookie))
    expect(form.body).toBe('Try again')
  })
})

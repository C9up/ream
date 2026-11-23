/**
 * A route's `.guard()` / `.role()` refusal renders itself through the error's
 * own `handle`, exactly as `@c9up/warden`'s refusal of the same request does:
 * one failure, one response shape, whichever of the two raised it.
 */
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { createHttpKernel, type HttpKernelRequest } from '../../src/HttpKernel.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'
import { Router } from '../../src/router/Router.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

function request(method: string, path: string, headers: Record<string, string>): HttpKernelRequest {
  return { method, path, query: '', headers, body: '' }
}

/** Signs every request in as an editor, never an admin. */
async function signedInEditor(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
  ctx.auth = { isAuthenticated: true, user: { id: 'u1', roles: ['editor'] } }
  await next()
}

function adminOnlyKernel() {
  const router = new Router()
  router.get('/admin', (ctx: HttpContext) => ctx.response.send('ran')).role('admin')
  return createHttpKernel({
    router,
    middleware: new MiddlewareRegistry(),
    serverMiddleware: [signedInEditor],
  })
}

function sessionCookie(headers: Record<string, unknown>): string | undefined {
  const raw = headers['set-cookie']
  const lines = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split('\n')
  return lines
    .map((line) => line.split(';')[0] ?? '')
    .find((pair) => pair.startsWith('ream_session='))
}

describe('route .role() refusal', () => {
  it('answers a JSON client { errors: [{ message }] } with 403', async () => {
    const response = await adminOnlyKernel()(
      request('GET', '/admin', { accept: 'application/json' }),
    )

    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ errors: [{ message: 'Access denied' }] })
  })

  it('answers a JSON:API client with the code and the message', async () => {
    const response = await adminOnlyKernel()(
      request('GET', '/admin', { accept: 'application/vnd.api+json' }),
    )

    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({
      errors: [{ code: 'E_AUTHORIZATION_FAILURE', title: 'Access denied' }],
    })
  })

  it('answers an HTML client the message as text with 403', async () => {
    const response = await adminOnlyKernel()(request('GET', '/admin', { accept: 'text/html' }))

    expect(response.status).toBe(403)
    expect(response.body).toBe('Access denied')
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
  })

  it('flashes a denied form submission and redirects it back, the session committed', async () => {
    const signer = new CookieSigner('test-app-key-32-bytes-long-xxxxxx')
    const container = new Container()
    container.singleton('encryption', () => signer)
    const session = new SessionMiddleware({
      store: 'memory',
      cookieName: 'ream_session',
      maxAge: 3600,
    })
    const router = new Router()
    router.post('/admin', (ctx: HttpContext) => ctx.response.send('ran')).role('admin')
    router.get('/form', (ctx: HttpContext) => {
      ctx.response.json({
        error: ctx.session?.flashMessages.get('error') ?? null,
        errorsBag: ctx.session?.flashMessages.get('errorsBag') ?? null,
      })
    })
    const kernel = createHttpKernel({
      router,
      container,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [(ctx, next) => session.handle(ctx, next), signedInEditor],
    })

    const refused = await kernel(
      request('POST', '/admin', { accept: 'text/html', referer: '/form' }),
    )

    expect(refused.status).toBe(302)
    expect(refused.headers.location).toBe('/form')
    const cookie = sessionCookie(refused.headers)
    expect(cookie).toBeDefined()
    const form = await kernel(request('GET', '/form', { cookie: cookie ?? '' }))
    expect(JSON.parse(form.body)).toEqual({
      error: 'Access denied',
      errorsBag: { E_AUTHORIZATION_FAILURE: 'Access denied' },
    })
  })

  it('translates the message through ctx.i18n', async () => {
    const router = new Router()
    router.get('/admin', (ctx: HttpContext) => ctx.response.send('ran')).role('admin')
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [
        async (ctx, next) => {
          Reflect.set(ctx, 'i18n', {
            t: (identifier: string, _data: unknown, options?: { defaultValue?: string }) =>
              identifier === 'errors.E_AUTHORIZATION_FAILURE'
                ? 'Accès refusé'
                : (options?.defaultValue ?? identifier),
          })
          await next()
        },
        signedInEditor,
      ],
    })

    const response = await kernel(request('GET', '/admin', { accept: 'application/json' }))

    expect(JSON.parse(response.body)).toEqual({ errors: [{ message: 'Accès refusé' }] })
  })
})

describe('route .guard() refusal', () => {
  it('answers 401 { error: { code, message } } to a JSON and to an HTML client alike', async () => {
    const router = new Router()
    router.get('/me', (ctx: HttpContext) => ctx.response.send('ran')).guard('jwt')
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })

    for (const accept of ['application/json', 'text/html']) {
      const response = await kernel(request('GET', '/me', { accept }))

      expect(response.status).toBe(401)
      expect(JSON.parse(response.body)).toEqual({
        error: { code: 'E_UNAUTHORIZED_ACCESS', message: 'Unauthorized access' },
      })
    }
  })
})

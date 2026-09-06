/**
 * `router.use([() => import('@c9up/ream/session_middleware')])` — the shape the
 * framework documents — hands the container a class and nothing else. The
 * settings therefore have to reach the middleware through `config/session.ts`,
 * which the config loader already reads into `config.get('session')`.
 *
 * Before this, a middleware registered that way was built with no config at
 * all: the cookie store refused to start for want of a secret, and the only way
 * to configure one was to construct the middleware by hand in `start/kernel.ts`
 * — which `router.use()` does not accept.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Application } from '../../src/Application.js'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { clearApp, setApp } from '../../src/services/app.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

let current: Application | undefined

/** An application whose config store holds what `config/*.ts` would have. */
function appWithConfig(config: Record<string, unknown>): Application {
  const app = new Application()
  app.setAppRoot(new URL('file:///project/'))
  app.config.loadFromObject(config)
  setApp(app)
  current = app
  return app
}

/** Release the locator so the next test starts from no application at all. */
function releaseApp(): void {
  if (current !== undefined) clearApp(current)
  current = undefined
}

afterEach(releaseApp)

describe('ream > middleware config from config/*.ts', () => {
  it('declares no constructor parameter the container has to resolve', () => {
    // An optional parameter still counts toward `Function.length`, and the
    // container refuses a class whose parameters it cannot resolve. Both
    // middlewares were unusable through `router.use([() => import('…')])`
    // because of it — the app answered 500 on its first request.
    expect(SessionMiddleware.length).toBe(0)
    expect(BodyParserMiddleware.length).toBe(0)
  })

  it('builds the session store from config/session.ts', () => {
    appWithConfig({
      session: { store: 'cookie', secret: 'a'.repeat(32), cookieName: 'from_config' },
    })
    // No argument — exactly what the container passes.
    const middleware = new SessionMiddleware()
    // The cookie store is the one that refuses to exist without a secret, so
    // reaching construction at all proves the secret arrived.
    expect(middleware).toBeInstanceOf(SessionMiddleware)
  })

  it('still refuses a cookie store whose config file forgot the secret', () => {
    appWithConfig({ session: { store: 'cookie' } })
    expect(() => new SessionMiddleware()).toThrow(/secret/i)
  })

  it('lets an explicit argument win over the config file', () => {
    appWithConfig({ session: { store: 'cookie', secret: 'a'.repeat(32) } })
    // A host that configures the middleware itself must not have the file
    // merged into what it passed.
    const middleware = new SessionMiddleware({ store: 'memory' })
    expect(middleware).toBeInstanceOf(SessionMiddleware)
  })

  it('reads bodyparser settings from config/bodyparser.ts', async () => {
    appWithConfig({ bodyparser: { allowedMethods: ['PATCH'] } })
    const ctx = formCtx('POST')
    await new BodyParserMiddleware().handle(ctx, async () => {})
    // POST is not in the configured list, so the body is left unparsed.
    expect(ctx.request.body()).toEqual({})
  })

  it('falls back to the defaults with no application at all', async () => {
    releaseApp()
    const ctx = formCtx('POST')
    await new BodyParserMiddleware().handle(ctx, async () => {})
    // The default allowedMethods include POST, so the form body is parsed.
    expect(ctx.request.body()).toEqual({ hello: 'world' })
  })
})

/** A real context carrying one form-encoded body, the way bodyparser.test.ts builds one. */
function formCtx(method: string): HttpContext {
  const body = 'hello=world'
  const raw: RawRequest = {
    method,
    path: '/',
    query: '',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // The middleware returns early on a bodyless request, so the length has
      // to be there for the parse to be reached at all.
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
    body,
  }
  return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
}

/**
 * A lazily imported controller (`[() => import('./x.js'), 'action']`, or a
 * `'XController.action'` reference) is on `ctx.route` from the FIRST request:
 * it is imported before the route info and the context are built. Imported
 * later, a middleware reading the action's decorators through `ctx.route`
 * found nothing on that request and took a protected action for a public one.
 */
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { hotReloadHappened } from '../../src/dev/hmr.js'
import type { HttpKernelRequest } from '../../src/HttpKernel.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import {
  Container,
  createHttpKernel,
  type MiddlewareFunction,
  MiddlewareRegistry,
  Router,
} from '../../src/index.js'

/** A decorator of an auth package: metadata on the action, read by a middleware. */
const PROTECTED = Symbol.for('test:protected')
function Protected(): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(PROTECTED, true, target, propertyKey)
  }
}

let ran: string[] = []

class VaultController {
  @Protected()
  async rotate(ctx: HttpContext): Promise<void> {
    ran.push('rotate')
    ctx.response.send('rotated')
  }

  @Protected()
  async export(ctx: HttpContext): Promise<void> {
    ran.push('export')
    ctx.response.send('exported')
  }

  async ping(ctx: HttpContext): Promise<void> {
    ran.push('ping')
    ctx.response.send('pong')
  }
}

/** What each middleware saw on `ctx.route`, per request. */
let seen: Array<{ where: string; controller: unknown; action: unknown }> = []

/**
 * The decorator gate of an auth package: refuses an action carrying the
 * decorator, lets everything else through. It only knows what `ctx.route`
 * tells it.
 */
function decoratorGate(where: string): MiddlewareFunction {
  return async (ctx, next) => {
    const { controller, action } = ctx.route
    seen.push({ where, controller, action })
    if (
      controller !== undefined &&
      action !== undefined &&
      Reflect.getMetadata(PROTECTED, controller, action) === true
    ) {
      ctx.response.status(401).send('refused by the decorator gate')
      return
    }
    await next()
  }
}

const request = (method: string, path: string): HttpKernelRequest => ({
  method,
  path,
  query: '',
  headers: { accept: 'application/json' },
  body: '',
})

function app(stack: 'router' | 'server', declare: (router: Router) => void) {
  ran = []
  seen = []
  const router = new Router()
  declare(router)
  return createHttpKernel({
    router,
    container: new Container(),
    middleware: new MiddlewareRegistry(),
    serverMiddleware: stack === 'server' ? [decoratorGate('server')] : [],
    routerMiddleware: stack === 'router' ? [decoratorGate('router')] : [],
  })
}

const lazy = async () => ({ default: VaultController })

describe('lazy controller > ctx.route on the first request', () => {
  for (const stack of ['router', 'server'] as const) {
    it(`names the controller and the action to a ${stack} middleware, the first time`, async () => {
      const kernel = app(stack, (router) => {
        router.post('/keys/rotate', [lazy, 'rotate'])
      })
      const first = await kernel(request('POST', '/keys/rotate'))
      const second = await kernel(request('POST', '/keys/rotate'))
      expect([first.status, second.status]).toEqual([401, 401])
      expect(ran).toEqual([])
      expect(seen).toEqual([
        { where: stack, controller: VaultController.prototype, action: 'rotate' },
        { where: stack, controller: VaultController.prototype, action: 'rotate' },
      ])
    })
  }

  it('holds for requests that arrive together, before the import settles', async () => {
    const kernel = app('router', (router) => {
      router.post('/keys/rotate', [lazy, 'rotate'])
    })
    const statuses = await Promise.all([
      kernel(request('POST', '/keys/rotate')),
      kernel(request('POST', '/keys/rotate')),
      kernel(request('POST', '/keys/rotate')),
    ])
    expect(statuses.map((response) => response.status)).toEqual([401, 401, 401])
    expect(ran).toEqual([])
  })

  it('holds for each route of one controller, each with its own first request', async () => {
    const kernel = app('router', (router) => {
      router.post('/keys/rotate', [lazy, 'rotate'])
      router.get('/export', [lazy, 'export'])
      router.get('/ping', [lazy, 'ping'])
    })
    expect((await kernel(request('POST', '/keys/rotate'))).status).toBe(401)
    expect((await kernel(request('GET', '/export'))).status).toBe(401)
    // An action without the decorator runs, the first time too.
    const ping = await kernel(request('GET', '/ping'))
    expect([ping.status, ping.body]).toEqual([200, 'pong'])
    expect(ran).toEqual(['ping'])
    expect(seen.map((entry) => entry.action)).toEqual(['rotate', 'export', 'ping'])
  })

  it("holds for a 'Controller.action' string reference", async () => {
    const kernel = app('router', (router) => {
      router.controllers({ VaultController: lazy })
      router.post('/keys/rotate', 'VaultController.rotate')
    })
    expect((await kernel(request('POST', '/keys/rotate'))).status).toBe(401)
    expect(ran).toEqual([])
    expect(seen[0]).toEqual({
      where: 'router',
      controller: VaultController.prototype,
      action: 'rotate',
    })
  })
})

describe('lazy controller > an import that fails', () => {
  it('answers the error, never the action, and imports again on the next request', async () => {
    let attempts = 0
    const kernel = app('server', (router) => {
      router.post('/keys/rotate', [
        async () => {
          attempts += 1
          if (attempts === 1) throw new Error('Cannot find module ./vault_controller.js')
          return { default: VaultController }
        },
        'rotate',
      ])
    })
    const failed = await kernel(request('POST', '/keys/rotate'))
    expect(failed.status).toBe(500)
    expect(ran).toEqual([])
    // The server middleware ran with no controller to read and let the
    // request on; it still ended in the error, not in a handler.
    expect(seen).toEqual([{ where: 'server', controller: undefined, action: undefined }])

    const retried = await kernel(request('POST', '/keys/rotate'))
    expect(retried.status).toBe(401)
    expect(attempts).toBe(2)
    expect(ran).toEqual([])
  })

  it('refuses a module with no default export', async () => {
    const empty: () => Promise<{ default: typeof VaultController }> = async () =>
      Object.create(null)
    const kernel = app('router', (router) => {
      router.get('/ping', [empty, 'ping'])
    })
    const response = await kernel(request('GET', '/ping'))
    expect(response.status).toBe(500)
    expect(JSON.parse(response.body).error.code).toBe('E_APP_MISSING_DEFAULT_EXPORT')
    expect(ran).toEqual([])
  })
})

describe('lazy controller > after a hot swap', () => {
  it('puts the newly imported class on ctx.route, with its decorators', async () => {
    class OpenController {
      async show(ctx: HttpContext): Promise<void> {
        ran.push('open')
        ctx.response.send('open')
      }
    }
    class ClosedController {
      @Protected()
      async show(ctx: HttpContext): Promise<void> {
        ran.push('closed')
        ctx.response.send('closed')
      }
    }
    let current: typeof OpenController | typeof ClosedController = OpenController
    const kernel = app('router', (router) => {
      router.get('/report', [async () => ({ default: current }), 'show'])
    })
    expect((await kernel(request('GET', '/report'))).status).toBe(200)

    // The developer adds the decorator and saves: the module is swapped.
    current = ClosedController
    hotReloadHappened()
    const swapped = await kernel(request('GET', '/report'))
    expect(swapped.status).toBe(401)
    expect(seen.map((entry) => entry.controller)).toEqual([
      OpenController.prototype,
      ClosedController.prototype,
    ])
    expect(ran).toEqual(['open'])
  })
})

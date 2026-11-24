import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../src/bootstrap/hyper-server.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { AppContext } from '../../src/index.js'
import {
  ConfigStore,
  Container,
  errors,
  Ignitor,
  OpenApiGenerator,
  OpenApiProvider,
  Router,
} from '../../src/index.js'
import type { OpenApiDocsConfig } from '../../src/openapi/OpenApiProvider.js'

function buildApp(container: Container, openapi?: OpenApiDocsConfig): AppContext {
  const config = new ConfigStore()
  if (openapi !== undefined) config.set('openapi', openapi)
  return { container, config }
}

function get(path: string): HttpContext {
  return new HttpContext(
    'test',
    { method: 'GET', path, query: '', headers: {}, body: '' },
    {},
    { pattern: path, middleware: [] },
  )
}

/** Start the provider on a real router and return it. */
async function mount(openapi?: OpenApiDocsConfig): Promise<Router> {
  const container = new Container()
  const router = new Router()
  container.singleton('router', () => router)
  router.get('/users', () => 'users')
  const generator = new OpenApiGenerator(router, { title: 'My API', version: '2.0.0' })
  const provider = new OpenApiProvider(buildApp(container, openapi), { generator })
  await provider.boot()
  await provider.start()
  return router
}

function route(router: Router, path: string) {
  return router.getRoutes().find((r) => r.method === 'GET' && r.path === path)
}

async function call(router: Router, path: string) {
  const handler = route(router, path)?.handler
  if (!handler) throw new Error(`no route ${path}`)
  const ctx = get(path)
  await handler(ctx)
  return { contentType: ctx.response.getHeader('content-type'), body: ctx.response.getBody() }
}

let previousEnv: string | undefined
beforeEach(() => {
  previousEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
})
afterEach(() => {
  if (previousEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousEnv
})

describe('OpenApiProvider', () => {
  it('serves the lazily-generated JSON spec at /api-docs, without its own routes', async () => {
    const router = await mount()
    const out = await call(router, '/api-docs')
    expect(out.contentType).toBe('application/json')
    const spec = JSON.parse(out.body)
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info).toEqual({ title: 'My API', version: '2.0.0' })
    expect(Object.keys(spec.paths)).toEqual(['/users'])
  })

  it('serves the Swagger UI HTML at /docs', async () => {
    const router = await mount()
    const out = await call(router, '/docs')
    expect(out.contentType).toBe('text/html')
    expect(out.body).toContain('swagger-ui')
    expect(out.body).toContain('<title>My API</title>')
  })

  it('mounts on the configured paths', async () => {
    const router = await mount({ specPath: '/openapi.json', docsPath: '/swagger' })
    expect(route(router, '/openapi.json')).toBeDefined()
    expect(route(router, '/swagger')).toBeDefined()
    expect(route(router, '/api-docs')).toBeUndefined()
  })

  it('is off in production unless enabled explicitly', async () => {
    process.env.NODE_ENV = 'production'
    expect(route(await mount(), '/api-docs')).toBeUndefined()
    expect(route(await mount({ enabled: true }), '/api-docs')).toBeDefined()
  })

  it('stays off when disabled outside production', async () => {
    expect(route(await mount({ enabled: false }), '/api-docs')).toBeUndefined()
  })

  it('puts the configured guards and middleware on both routes', async () => {
    const inline = async (_ctx: HttpContext, next: () => Promise<void>) => next()
    const router = await mount({ guards: ['web'], middleware: ['admin', inline] })
    for (const path of ['/api-docs', '/docs']) {
      const definition = route(router, path)
      expect(definition?.guards).toEqual([['web']])
      expect(definition?.middleware).toEqual(['admin'])
      expect(definition?.inlineMiddleware).toEqual([inline])
    }
  })

  it('refuses `guards: []`, which would read as protected and protect nothing', async () => {
    await expect(mount({ guards: [] })).rejects.toBeInstanceOf(errors.E_EMPTY_GATE_REQUIREMENT)
  })
})

describe('OpenApiProvider over HTTP', () => {
  let ignitor: Ignitor | undefined

  afterEach(async () => {
    await ignitor?.stop()
    ignitor = undefined
  })

  /** An app whose kernel refuses every request without `Authorization`. */
  async function boot(openapi?: OpenApiDocsConfig): Promise<number> {
    const app = new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
    ignitor = app
    if (openapi) app.configure('openapi', openapi)
    app.useRcFile({
      providers: [() => import('../../src/openapi/OpenApiProvider.js')],
      preloads: [
        async () => {
          app.getServer().use([
            async (ctx, next) => {
              if (!ctx.request.header('authorization')) {
                ctx.response.status(401).json({ error: 'authentication required' })
                return
              }
              await next()
            },
          ])
        },
        async () => {
          app.getRouter().get('/api/v1/health', ({ response }) => response.send('ok'))
        },
      ],
    })
    await app.httpServer().start()
    return app.port()
  }

  it('answers 404 in production when the app did not enable it', async () => {
    process.env.NODE_ENV = 'production'
    const port = await boot()
    const headers = { authorization: 'Bearer x' }
    expect((await fetch(`http://127.0.0.1:${port}/api-docs`, { headers })).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/docs`, { headers })).status).toBe(404)
  })

  it("runs behind the application's own server middleware", async () => {
    process.env.NODE_ENV = 'production'
    const port = await boot({ enabled: true })

    expect((await fetch(`http://127.0.0.1:${port}/api-docs`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/docs`)).status).toBe(401)

    const spec = await fetch(`http://127.0.0.1:${port}/api-docs`, {
      headers: { authorization: 'Bearer x' },
    })
    expect(spec.status).toBe(200)
    const body: { paths: Record<string, unknown> } = await spec.json()
    expect(Object.keys(body.paths)).toEqual(['/api/v1/health'])
  })

  it('refuses an anonymous request when a guard is configured', async () => {
    const port = await boot({ guards: ['web'] })
    const res = await fetch(`http://127.0.0.1:${port}/api-docs`, {
      headers: { authorization: 'Bearer x' },
    })
    expect(res.status).toBe(401)
  })
})

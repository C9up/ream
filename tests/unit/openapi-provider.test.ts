import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { AppContext, ConfigStore } from '../../src/index.js'
import { Container, OpenApiGenerator, OpenApiProvider, Router } from '../../src/index.js'

function buildApp(container: Container): AppContext {
  const config: ConfigStore = { get: () => undefined, set: () => {} }
  return { container, config }
}

/** Minimal HttpContext-shaped mock recording the response. */
function mockCtx(path: string): {
  ctx: { request: { path(): string; method(): string }; response: unknown }
  out: { headers: Record<string, string>; body?: string }
} {
  const out: { headers: Record<string, string>; body?: string } = { headers: {} }
  const response = {
    header(k: string, v: string) {
      out.headers[k] = v
      return this
    },
    status(_code: number) {
      return this
    },
    send(body: string) {
      out.body = body
    },
  }
  return {
    ctx: { request: { path: () => path, method: () => 'GET' }, response },
    out,
  }
}

/** Boot the provider against a stub server, returning the mounted middleware. */
async function mountMiddleware(): Promise<
  (ctx: unknown, next: () => Promise<void>) => Promise<void>
> {
  const container = new Container()
  const used: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>> = []
  container.singleton('server', () => ({
    use(mws: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>>): void {
      used.push(...mws)
    },
  }))
  const generator = new OpenApiGenerator(new Router(), {
    title: 'My API',
    version: '2.0.0',
  })
  const provider = new OpenApiProvider(buildApp(container), { generator })
  await provider.boot()
  expect(used).toHaveLength(1)
  return used[0]
}

describe('OpenApiProvider', () => {
  it('serves the lazily-generated JSON spec at /api-docs', async () => {
    const middleware = await mountMiddleware()
    const { ctx, out } = mockCtx('/api-docs')
    await middleware(ctx, async () => {})
    expect(out.headers['Content-Type']).toBe('application/json')
    const spec = JSON.parse(out.body ?? '{}')
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('My API')
    expect(spec.info.version).toBe('2.0.0')
  })

  it('serves the Swagger UI HTML at /docs', async () => {
    const middleware = await mountMiddleware()
    const { ctx, out } = mockCtx('/docs')
    await middleware(ctx, async () => {})
    expect(out.headers['Content-Type']).toBe('text/html')
    expect(out.body).toContain('swagger-ui')
    expect(out.body).toContain('<title>My API</title>')
  })

  it('falls through (next) for unrelated paths', async () => {
    const middleware = await mountMiddleware()
    const { ctx, out } = mockCtx('/users')
    let nexted = false
    await middleware(ctx, async () => {
      nexted = true
    })
    expect(nexted).toBe(true)
    expect(out.body).toBeUndefined()
  })
})

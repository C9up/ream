/**
 * The development pages (`/__ream/…`) answer only a host the server is meant
 * to be reached by. Without the check, DNS rebinding let any web page the
 * developer had open read the profiler's recorded requests.
 */
import 'reflect-metadata'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { createHyperServerFactory } from '../../src/bootstrap/hyper-server.js'
import { isHostAllowed } from '../../src/dev/hostGuard.js'
import { Ignitor } from '../../src/index.js'

describe('dev > isHostAllowed', () => {
  it.each([
    'localhost',
    'localhost:3333',
    'LOCALHOST:3333',
    'app.localhost:3333',
    '127.0.0.1:3333',
    '192.168.1.20',
    '[::1]:3333',
  ])('accepts %s by default', (host) => {
    expect(isHostAllowed(host, {})).toBe(true)
  })

  it.each([
    'attacker.example',
    'attacker.example:3333',
    'localhost.attacker.example',
    '[not-an-ip]:3333',
    '[::1',
  ])('refuses %s by default', (host) => {
    expect(isHostAllowed(host, {})).toBe(false)
  })

  it('accepts the bind host and the listed names', () => {
    expect(isHostAllowed('devbox:3333', { bindHost: () => 'devbox' })).toBe(true)
    expect(isHostAllowed('app.test', { allowedHosts: ['app.test'] })).toBe(true)
    expect(isHostAllowed('api.example.dev', { allowedHosts: ['.example.dev'] })).toBe(true)
    expect(isHostAllowed('example.dev', { allowedHosts: ['.example.dev'] })).toBe(true)
    expect(isHostAllowed('notexample.dev', { allowedHosts: ['.example.dev'] })).toBe(false)
    expect(isHostAllowed('anything', { allowedHosts: true })).toBe(true)
  })

  it('lets a request without Host through, as Vite does', () => {
    expect(isHostAllowed(undefined, {})).toBe(true)
  })
})

function call(
  port: number,
  options: { method?: string; path: string; host: string; body?: string; fetchSite?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host }
    if (options.fetchSite) headers['sec-fetch-site'] = options.fetchSite
    if (options.body) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(options.body))
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: options.path, method: options.method ?? 'GET', headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('dev > the profiler pages over HTTP', () => {
  const saved = process.env.NODE_ENV
  let ignitor: Ignitor | undefined

  beforeEach(() => {
    process.env.NODE_ENV = 'development'
  })

  afterEach(async () => {
    await ignitor?.stop()
    ignitor = undefined
    if (saved === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved
  })

  async function boot(allowedHosts?: string[]): Promise<number> {
    const bodyParser = new BodyParserMiddleware()
    const app = new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
      ...(allowedHosts ? { allowedHosts } : {}),
    })
    ignitor = app
    await app
      .use((ctx, next) => bodyParser.handle(ctx, next))
      .routes((router) =>
        router.post('/patients', ({ request, response }) =>
          response.json({ saved: request.input('name') }),
        ),
      )
      .httpServer()
      .start()
    return app.port()
  }

  async function record(port: number): Promise<string> {
    const own = await call(port, {
      method: 'POST',
      path: '/patients',
      host: `localhost:${port}`,
      body: JSON.stringify({ name: 'Ada Lovelace', diagnosis: 'confidential' }),
    })
    expect(own.status).toBe(200)
    return String(own.headers['x-debug-token'])
  }

  it('refuses a foreign Host before reading the store', async () => {
    const port = await boot()
    const token = await record(port)
    const host = `attacker.example:${port}`

    for (const path of ['/__ream/profiler', `/__ream/profiler/${token}.json`, '/__ream/hmr']) {
      const res = await call(port, { path, host })
      expect(res.status).toBe(403)
      expect(res.body).toBe('Blocked request. This host ("attacker.example") is not allowed.')
      expect(res.body).not.toContain('Ada')
    }
  })

  it('answers its own host, and a listed one', async () => {
    const port = await boot(['dev.example.test'])
    const token = await record(port)

    const own = await call(port, {
      path: `/__ream/profiler/${token}.json`,
      host: `localhost:${port}`,
    })
    expect(own.status).toBe(200)
    expect(JSON.parse(own.body).data.request.body).toEqual({
      name: 'Ada Lovelace',
      diagnosis: 'confidential',
    })
    const listed = await call(port, { path: '/__ream/profiler', host: `dev.example.test:${port}` })
    expect(listed.status).toBe(200)
  })

  it('refuses a request the browser marks cross-site', async () => {
    const port = await boot()
    const res = await call(port, {
      path: '/__ream/profiler',
      host: `localhost:${port}`,
      fetchSite: 'cross-site',
    })
    expect(res.status).toBe(403)
  })

  it("leaves the application's own pages alone", async () => {
    const port = await boot()
    const res = await call(port, {
      method: 'POST',
      path: '/patients',
      host: `attacker.example:${port}`,
      body: '{"name":"x"}',
    })
    expect(res.status).toBe(200)
  })
})

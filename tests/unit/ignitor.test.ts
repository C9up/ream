import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Ignitor, Provider } from '../../src/index.js'
import type { AppContext, ErrorEvent, HyperServerLike, ReamrcConfig } from '../../src/index.js'

class MockHyperServer implements HyperServerLike {
  private handler?: (reqJson: string) => Promise<string>
  private _port: number
  listening = false
  constructor(port: number) { this._port = port }
  onRequest(cb: (r: string) => Promise<string>) { this.handler = cb }
  async listen() { this.listening = true }
  async port() { return this._port }
  async close() { this.listening = false }
  async request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    if (!this.handler) throw new Error('No handler')
    return JSON.parse(await this.handler(JSON.stringify({ method, path, query: '', headers, body })))
  }
}

function mockFactory() {
  let srv: MockHyperServer | undefined
  return { factory: (p: number) => { srv = new MockHyperServer(p); return srv }, get: () => srv! }
}

describe('ignitor > 4-phase lifecycle (AdonisJS-style)', () => {
  it('register → boot → start → ready → shutdown', async () => {
    const log: string[] = []
    class LP extends Provider {
      register() { log.push('register') }
      async boot() { log.push('boot') }
      async start() { log.push('start') }
      async ready() { log.push('ready') }
      async shutdown() { log.push('shutdown') }
    }
    const { factory } = mockFactory()
    const app = await new Ignitor({ port: 3000, serverFactory: factory })
      .httpServer()
      .provider(a => new LP(a))
      .start()
    expect(log).toEqual(['register', 'boot', 'start', 'ready'])
    expect(app.getPhase()).toBe('ready')
    await app.stop()
    expect(log).toEqual(['register', 'boot', 'start', 'ready', 'shutdown'])
  })

  it('reamrc manifest loads providers and preloads', async () => {
    const log: string[] = []
    class DbProv extends Provider {
      register() { log.push('db:register') }
      async boot() { log.push('db:boot') }
    }
    const rc: ReamrcConfig = {
      providers: [async () => ({ default: DbProv as unknown as new (a: AppContext) => Provider })],
      preloads: [async () => { log.push('preload:routes') }, async () => { log.push('preload:kernel') }],
    }
    await new Ignitor().useRcFile(rc).start()
    expect(log).toEqual(['db:register', 'db:boot', 'preload:routes', 'preload:kernel'])
  })

  it('bin/server.ts pattern', async () => {
    const { factory, get } = mockFactory()
    await new Ignitor({ port: 0, serverFactory: factory })
      .httpServer()
      .routes(r => r.get('/hello', async ctx => { ctx.response.send('Hello Ream!') }))
      .start()
    const res = await get().request('GET', '/hello')
    expect(res.status).toBe(200)
    expect(res.body).toBe('Hello Ream!')
  })
})

describe('ignitor > HTTP serving', () => {
  it('middleware + handler', async () => {
    const { factory, get } = mockFactory()
    const log: string[] = []
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .use(async (_c, next) => { log.push('mw'); await next() })
      .routes(r => r.get('/t', async () => { log.push('h') }))
      .start()
    await get().request('GET', '/t')
    expect(log).toEqual(['mw', 'h'])
  })

  it('404 on unmatched', async () => {
    const { factory, get } = mockFactory()
    await new Ignitor({ serverFactory: factory }).httpServer().start()
    expect((await get().request('GET', '/x')).status).toBe(404)
  })

  it('500 on error + onError callback', async () => {
    const { factory, get } = mockFactory()
    const errs: ErrorEvent[] = []
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .routes(r => r.get('/err', async () => { throw new Error('boom') }))
      .onError(e => errs.push(e))
      .start()
    expect((await get().request('GET', '/err')).status).toBe(500)
    expect(errs.length).toBe(1)
  })

  it('params extracted', async () => {
    const { factory, get } = mockFactory()
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .routes(r => r.get('/o/:id', async ctx => { ctx.response.send(ctx.params.id ?? '') }))
      .start()
    expect((await get().request('GET', '/o/42')).body).toBe('42')
  })

  it('groups with prefix', async () => {
    const { factory, get } = mockFactory()
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .routes(r => r.group({ prefix: '/api' }, a => a.get('/users', async ctx => { ctx.response.send('users') })))
      .start()
    expect((await get().request('GET', '/api/users')).body).toBe('users')
  })

  it('response.json() sets content-type', async () => {
    const { factory, get } = mockFactory()
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .routes(r => r.get('/json', async ctx => { ctx.response.json({ hello: 'world' }) }))
      .start()
    const res = await get().request('GET', '/json')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ hello: 'world' })
    expect(res.headers['content-type']).toBe('application/json')
  })

  it('response.status().json() sets custom status', async () => {
    const { factory, get } = mockFactory()
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .routes(r => r.post('/create', async ctx => { ctx.response.status(201).json({ created: true }) }))
      .start()
    const res = await get().request('POST', '/create')
    expect(res.status).toBe(201)
  })
})

describe('ignitor > toolkit mode', () => {
  it('kernel without server', async () => {
    const app = await new Ignitor()
      .routes(r => r.get('/data', async ctx => { ctx.response.send('toolkit') }))
      .start()
    const res = JSON.parse(await app.getKernel()(JSON.stringify({ method: 'GET', path: '/data', query: '', headers: {}, body: '' })))
    expect(res.body).toBe('toolkit')
    await app.stop()
  })
})

describe('ignitor > environment', () => {
  it('httpServer sets web', () => { expect(new Ignitor().httpServer().getEnvironment()).toBe('web') })
  it('testMode sets test', () => { expect(new Ignitor().testMode().getEnvironment()).toBe('test') })
  it('console sets console', () => { expect(new Ignitor().console().getEnvironment()).toBe('console') })
})

describe('ignitor > controller resolution', () => {
  it('resolves controller tuple [Class, method]', async () => {
    class GreetController {
      async hello(ctx: import('../../src/http/HttpContext.js').HttpContext) {
        ctx.response.json({ greeting: 'Hello from controller!' })
      }
    }
    const { factory, get } = mockFactory()
    await new Ignitor({ serverFactory: factory })
      .httpServer()
      .routes(r => r.get('/greet', [GreetController, 'hello']))
      .start()
    const res = await get().request('GET', '/greet')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ greeting: 'Hello from controller!' })
  })
})

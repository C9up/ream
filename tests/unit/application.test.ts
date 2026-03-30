import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Application, Context, Provider, SimpleConfigStore, defineConfig, env } from '../../src/index.js'

describe('application > provider lifecycle', () => {
  it('registers and boots providers in order', async () => {
    const app = new Application()
    const log: string[] = []

    class TestProvider extends Provider {
      register() { log.push('register') }
      async boot() { log.push('boot') }
      async shutdown() { log.push('shutdown') }
    }

    app.register(new TestProvider(app))
    expect(log).toEqual(['register'])

    await app.boot()
    expect(log).toEqual(['register', 'boot'])

    await app.shutdown()
    expect(log).toEqual(['register', 'boot', 'shutdown'])
  })

  it('shuts down providers in reverse order', async () => {
    const app = new Application()
    const log: string[] = []

    class ProviderA extends Provider {
      async shutdown() { log.push('A') }
    }
    class ProviderB extends Provider {
      async shutdown() { log.push('B') }
    }

    app.register(new ProviderA(app))
    app.register(new ProviderB(app))
    await app.boot()
    await app.shutdown()

    expect(log).toEqual(['B', 'A']) // Reverse order
  })

  it('provider can register bindings in the container', () => {
    const app = new Application()

    class DbProvider extends Provider {
      register() {
        this.app.container.singleton('db', () => ({ connected: true }))
      }
    }

    app.register(new DbProvider(app))
    const db = app.container.resolve<{ connected: boolean }>('db')
    expect(db.connected).toBe(true)
  })
})

describe('config > SimpleConfigStore', () => {
  it('get and set values', () => {
    const config = new SimpleConfigStore()
    config.set('db.host', 'localhost')
    expect(config.get('db.host')).toBe('localhost')
    expect(config.get('nonexistent')).toBeUndefined()
  })

  it('loadFromObject loads multiple values', () => {
    const config = new SimpleConfigStore()
    config.loadFromObject({
      'db.host': 'localhost',
      'db.port': 5432,
      'app.name': 'Ream',
    })
    expect(config.get('db.host')).toBe('localhost')
    expect(config.get('db.port')).toBe(5432)
    expect(config.get('app.name')).toBe('Ream')
  })
})

describe('config > env helper', () => {
  it('reads environment variable', () => {
    process.env.TEST_VAR = 'hello'
    expect(env('TEST_VAR')).toBe('hello')
    delete process.env.TEST_VAR
  })

  it('returns default when not set', () => {
    expect(env('NONEXISTENT', 'default')).toBe('default')
  })

  it('returns undefined when no default', () => {
    expect(env('NONEXISTENT')).toBeUndefined()
  })
})

describe('config > defineConfig', () => {
  it('returns config as-is (type pass-through)', () => {
    const config = defineConfig({
      host: 'localhost',
      port: 3000,
    })
    expect(config.host).toBe('localhost')
    expect(config.port).toBe(3000)
  })
})

describe('context > unified', () => {
  it('creates HTTP context', () => {
    const ctx = Context.http('req-1', {
      method: 'GET',
      path: '/api/orders',
      query: 'page=1',
      headers: { 'content-type': 'application/json' },
      body: '',
    })

    expect(ctx.is('http')).toBe(true)
    expect(ctx.is('event')).toBe(false)
    expect(ctx.id).toBe('req-1')
    expect(ctx.request?.method).toBe('GET')
    expect(ctx.request?.path).toBe('/api/orders')
    expect(ctx.response?.status).toBe(200)
  })

  it('creates event context', () => {
    const ctx = Context.event('evt-1', {
      name: 'order.created',
      data: '{"orderId":"123"}',
      correlationId: 'corr-1',
    }, 'OrderService')

    expect(ctx.is('event')).toBe(true)
    expect(ctx.is('http')).toBe(false)
    expect(ctx.event?.name).toBe('order.created')
    expect(ctx.service?.name).toBe('OrderService')
  })

  it('auth defaults to unauthenticated', () => {
    const ctx = Context.http('1', { method: 'GET', path: '/', query: '', headers: {}, body: '' })
    expect(ctx.auth.authenticated).toBe(false)
    expect(ctx.auth.userId).toBeUndefined()
  })

  it('auth can be set', () => {
    const ctx = Context.http('1', { method: 'GET', path: '/', query: '', headers: {}, body: '' })
    ctx.auth = { authenticated: true, userId: 'user-1', roles: ['admin'] }
    expect(ctx.auth.authenticated).toBe(true)
    expect(ctx.auth.userId).toBe('user-1')
    expect(ctx.auth.roles).toContain('admin')
  })
})

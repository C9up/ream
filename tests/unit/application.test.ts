import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import {
  Application,
  defineModuleConfig,
  env,
  Provider,
  ConfigStore,
} from '../../src/index.js'

describe('application > provider lifecycle', () => {
  it('registers and boots providers in order', async () => {
    const app = new Application()
    const log: string[] = []

    class TestProvider extends Provider {
      register() {
        log.push('register')
      }
      async boot() {
        log.push('boot')
      }
      async shutdown() {
        log.push('shutdown')
      }
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
      async shutdown() {
        log.push('A')
      }
    }
    class ProviderB extends Provider {
      async shutdown() {
        log.push('B')
      }
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

  it('booted() on an already-booted app does not let a SYNC throw escape to the caller', async () => {
    const app = new Application()
    await app.boot()

    // Capture the logged error instead of letting it hit the test output.
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    try {
      // A synchronous throw inside the callback must be funnelled to the
      // logger, NOT thrown back here. Pre-fix, `Promise.resolve(cb())`
      // evaluated cb() eagerly and the throw escaped.
      expect(() => {
        app.booted(() => {
          throw new Error('sync boom')
        })
      }).not.toThrow()

      // The rejection is logged on the microtask queue — let it settle.
      await Promise.resolve()
      await Promise.resolve()
      const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(logged).toContain('booted() callback error')
      expect(logged).toContain('sync boom')
    } finally {
      writeSpy.mockRestore()
    }
  })
})

describe('config > ConfigStore', () => {
  it('get and set values', () => {
    const config = new ConfigStore()
    config.set('db.host', 'localhost')
    expect(config.get('db.host')).toBe('localhost')
    expect(config.get('nonexistent')).toBeUndefined()
  })

  it('loadFromObject loads multiple values', () => {
    const config = new ConfigStore()
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

describe('config > defineModuleConfig', () => {
  it('returns config as-is (type pass-through)', () => {
    const config = defineModuleConfig({
      host: 'localhost',
      port: 3000,
    })
    expect(config.host).toBe('localhost')
    expect(config.port).toBe(3000)
  })
})

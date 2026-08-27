import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Application, ConfigStore, defineModuleConfig, env, Provider } from '../../src/index.js'

describe('application > path helpers', () => {
  it('resolves makePath/configPath/migrationsPath/tmpPath/publicPath against the app root', () => {
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))

    expect(app.makePath('app', 'middleware.ts')).toBe('/project/app/middleware.ts')
    expect(app.configPath('shield.ts')).toBe('/project/config/shield.ts')
    expect(app.configPath()).toBe('/project/config')
    expect(app.migrationsPath()).toBe('/project/database/migrations')
    expect(app.tmpPath('logs', 'mail.txt')).toBe('/project/tmp/logs/mail.txt')
    expect(app.publicPath('style.css')).toBe('/project/public/style.css')
  })

  it('throws a helpful error when the app root is not set', () => {
    const app = new Application()
    expect(() => app.makePath('x')).toThrow(/app root is not set/)
  })

  it('resolves every conventional directory, AdonisJS layout for layout', () => {
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))

    // The whole family in one place: a helper silently pointing at the wrong
    // directory is the kind of thing nothing else would catch.
    expect(app.providersPath()).toBe('/project/providers')
    expect(app.factoriesPath()).toBe('/project/database/factories')
    expect(app.seedersPath()).toBe('/project/database/seeders')
    expect(app.languageFilesPath()).toBe('/project/resources/lang')
    expect(app.viewsPath()).toBe('/project/resources/views')
    expect(app.startPath('kernel.ts')).toBe('/project/start/kernel.ts')
    expect(app.contractsPath()).toBe('/project/contracts')
    expect(app.httpControllersPath()).toBe('/project/app/controllers')
    expect(app.modelsPath('user.ts')).toBe('/project/app/models/user.ts')
    expect(app.servicesPath()).toBe('/project/app/services')
    expect(app.exceptionsPath()).toBe('/project/app/exceptions')
    expect(app.mailersPath()).toBe('/project/app/mailers')
    expect(app.mailsPath()).toBe('/project/app/mails')
    expect(app.middlewarePath()).toBe('/project/app/middleware')
    expect(app.policiesPath()).toBe('/project/app/policies')
    expect(app.validatorsPath()).toBe('/project/app/validators')
    expect(app.commandsPath()).toBe('/project/commands')
    expect(app.eventsPath()).toBe('/project/app/events')
    expect(app.listenersPath()).toBe('/project/app/listeners')
    expect(app.transformersPath()).toBe('/project/app/transformers')
  })

  it('writes generated code under .ream, not .adonisjs', () => {
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))

    expect(app.generatedClientPath()).toBe('/project/.ream/client')
    expect(app.generatedServerPath('routes.ts')).toBe('/project/.ream/server/routes.ts')
  })

  it('rcContents moves a directory, and every helper follows', () => {
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))
    app.rcContents({ directories: { httpControllers: 'app/http/controllers' } })

    expect(app.httpControllersPath('users.ts')).toBe('/project/app/http/controllers/users.ts')
    // Everything not named keeps its default.
    expect(app.modelsPath()).toBe('/project/app/models')
    expect(app.directories.httpControllers).toBe('app/http/controllers')
  })

  it('an undefined override leaves the default alone rather than blanking it', () => {
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))
    app.rcContents({ directories: { models: undefined, views: 'app/views' } })

    expect(app.modelsPath()).toBe('/project/app/models')
    expect(app.viewsPath()).toBe('/project/app/views')
  })

  it('makeURL keeps forward slashes, and relativePath is its inverse', () => {
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))

    expect(app.makeURL('app', 'models', 'user.ts').href).toBe('file:///project/app/models/user.ts')
    expect(app.relativePath('/project/app/models/user.ts')).toBe('app/models/user.ts')
  })
})

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

  it('provider can register bindings in the container', async () => {
    const app = new Application()

    class DbProvider extends Provider {
      register() {
        this.app.container.singleton('db', () => ({ connected: true }))
      }
    }

    app.register(new DbProvider(app))
    const db = await app.container.resolve<{ connected: boolean }>('db')
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

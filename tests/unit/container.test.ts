import 'reflect-metadata'
import { beforeEach, describe, expect, it } from 'vitest'
import { Container, Inject, Service } from '../../src/index.js'

describe('container > basic resolution', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('resolves a singleton binding', () => {
    let callCount = 0
    container.singleton('config', () => {
      callCount++
      return { dbHost: 'localhost' }
    })

    const config1 = container.resolve<{ dbHost: string }>('config')
    const config2 = container.resolve<{ dbHost: string }>('config')

    expect(config1.dbHost).toBe('localhost')
    expect(config1).toBe(config2) // Same instance
    expect(callCount).toBe(1) // Factory called once
  })

  it('resolves a transient binding (new instance each time)', () => {
    let callCount = 0
    container.bind('dto', () => {
      callCount++
      return { id: callCount }
    })

    const dto1 = container.resolve<{ id: number }>('dto')
    const dto2 = container.resolve<{ id: number }>('dto')

    expect(dto1.id).toBe(1)
    expect(dto2.id).toBe(2)
    expect(dto1).not.toBe(dto2)
  })

  it('throws on unregistered token', () => {
    expect(() => container.resolve('nonexistent')).toThrow('No binding found')
  })
})

describe('container > @Service() auto-resolution', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('auto-resolves a @Service() decorated class', () => {
    @Service()
    class GreetingService {
      greet(name: string) {
        return `Hello, ${name}!`
      }
    }

    const service = container.resolve<InstanceType<typeof GreetingService>>(GreetingService)
    expect(service.greet('Ream')).toBe('Hello, Ream!')
  })

  it('resolves with explicit factory that has dependencies', () => {
    @Service()
    class Logger {
      log(msg: string) {
        return msg
      }
    }

    container.singleton('OrderService', () => {
      const logger = container.resolve<InstanceType<typeof Logger>>(Logger)
      return { logger }
    })

    const service = container.resolve<{ logger: InstanceType<typeof Logger> }>('OrderService')
    expect(service.logger).toBeInstanceOf(Logger)
    expect(service.logger.log('test')).toBe('test')
  })

  it('singleton scope returns same instance', () => {
    @Service({ scope: 'singleton' })
    class SingletonService {
      id = Math.random()
    }

    const a = container.resolve<InstanceType<typeof SingletonService>>(SingletonService)
    const b = container.resolve<InstanceType<typeof SingletonService>>(SingletonService)
    expect(a).toBe(b)
    expect(a.id).toBe(b.id)
  })

  it('transient scope returns different instances', () => {
    @Service({ scope: 'transient' })
    class TransientService {
      id = Math.random()
    }

    const a = container.resolve<InstanceType<typeof TransientService>>(TransientService)
    const b = container.resolve<InstanceType<typeof TransientService>>(TransientService)
    expect(a).not.toBe(b)
    expect(a.id).not.toBe(b.id)
  })
})

describe('container > override', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('override replaces a binding', () => {
    container.singleton('db', () => ({ type: 'postgres' }))

    const real = container.resolve<{ type: string }>('db')
    expect(real.type).toBe('postgres')

    container.override('db', { type: 'fake' })
    const fake = container.resolve<{ type: string }>('db')
    expect(fake.type).toBe('fake')
  })

  it('restore clears overrides', () => {
    container.singleton('db', () => ({ type: 'postgres' }))
    container.override('db', { type: 'fake' })

    expect(container.resolve<{ type: string }>('db').type).toBe('fake')

    container.restore()
    expect(container.resolve<{ type: string }>('db').type).toBe('postgres')
  })

  it('stacked overrides — last override wins', () => {
    container.singleton('db', () => ({ type: 'postgres' }))
    container.override('db', { type: 'sqlite' })
    container.override('db', { type: 'memory' })

    expect(container.resolve<{ type: string }>('db').type).toBe('memory')

    container.restore()
    expect(container.resolve<{ type: string }>('db').type).toBe('postgres')
  })

  it('multiple overrides on different bindings', () => {
    container.singleton('db', () => ({ type: 'postgres' }))
    container.singleton('cache', () => ({ type: 'redis' }))

    container.override('db', { type: 'sqlite' })
    container.override('cache', { type: 'memory' })

    expect(container.resolve<{ type: string }>('db').type).toBe('sqlite')
    expect(container.resolve<{ type: string }>('cache').type).toBe('memory')

    container.restore()
    expect(container.resolve<{ type: string }>('db').type).toBe('postgres')
    expect(container.resolve<{ type: string }>('cache').type).toBe('redis')
  })

  it('parallel isolation — separate container instances', () => {
    const c1 = new Container()
    const c2 = new Container()

    c1.singleton('db', () => ({ type: 'postgres' }))
    c2.singleton('db', () => ({ type: 'postgres' }))

    c1.override('db', { type: 'fake-1' })
    c2.override('db', { type: 'fake-2' })

    // Each container has its own override
    expect(c1.resolve<{ type: string }>('db').type).toBe('fake-1')
    expect(c2.resolve<{ type: string }>('db').type).toBe('fake-2')

    // Restoring one doesn't affect the other
    c1.restore()
    expect(c1.resolve<{ type: string }>('db').type).toBe('postgres')
    expect(c2.resolve<{ type: string }>('db').type).toBe('fake-2')
  })

  it('restore preserves singleton identity (M7)', () => {
    let factoryCalls = 0
    container.singleton('db', () => {
      factoryCalls++
      return { id: factoryCalls }
    })

    const original = container.resolve<{ id: number }>('db')
    expect(factoryCalls).toBe(1)

    container.override('db', { id: 999 })
    expect(container.resolve<{ id: number }>('db').id).toBe(999)

    container.restore('db')
    const after = container.resolve<{ id: number }>('db')
    // Same instance handed back — factory NOT re-invoked.
    expect(after).toBe(original)
    expect(factoryCalls).toBe(1)
  })

  it('restore() with no args also preserves singleton identity', () => {
    container.singleton('a', () => ({ tag: 'a' }))
    container.singleton('b', () => ({ tag: 'b' }))
    const a = container.resolve('a')
    const b = container.resolve('b')

    container.override('a', { tag: 'fake-a' })
    container.override('b', { tag: 'fake-b' })

    container.restore()

    expect(container.resolve('a')).toBe(a)
    expect(container.resolve('b')).toBe(b)
  })

  it('override on a token with no prior singleton clears cleanly on restore', () => {
    // No singleton registered → override sets the only value, restore wipes it
    container.override('orphan', 'fake')
    expect(container.resolve('orphan')).toBe('fake')

    container.restore('orphan')
    expect(() => container.resolve('orphan')).toThrow(/No binding found/)
  })

  it('rejects Symbol.for with a reserved description (M9)', () => {
    expect(() => container.override(Symbol.for('__proto__'), 'v')).toThrow(
      /Reserved container token name/,
    )
    expect(() => container.singleton(Symbol.for('constructor'), () => 'v')).toThrow(
      /Reserved container token name/,
    )
    expect(() => container.bind(Symbol.for('prototype'), () => 'v')).toThrow(
      /Reserved container token name/,
    )
  })
})

describe('container > @Inject() named binding', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('resolves named interface binding via explicit factory', () => {
    interface PaymentGateway {
      charge(amount: number): string
    }

    class StripeGateway implements PaymentGateway {
      charge(amount: number) {
        return `Charged $${amount} via Stripe`
      }
    }

    container.singleton('PaymentGateway', () => new StripeGateway())

    container.singleton('OrderService', () => {
      const payment = container.resolve<PaymentGateway>('PaymentGateway')
      return { payment }
    })

    const service = container.resolve<{ payment: PaymentGateway }>('OrderService')
    expect(service.payment.charge(42)).toBe('Charged $42 via Stripe')
  })

  it('override named binding for testing', () => {
    container.singleton('PaymentGateway', () => ({ charge: () => 'real' }))
    expect(container.resolve<{ charge: () => string }>('PaymentGateway').charge()).toBe('real')

    container.override('PaymentGateway', { charge: () => 'fake' })
    expect(container.resolve<{ charge: () => string }>('PaymentGateway').charge()).toBe('fake')
  })
})

describe('container > circular dependency detection', () => {
  it('detects circular dependency and throws with clear message', () => {
    const container = new Container()

    container.singleton('A', () => {
      container.resolve('B') // A depends on B
      return { name: 'A' }
    })

    container.singleton('B', () => {
      container.resolve('A') // B depends on A — circular!
      return { name: 'B' }
    })

    expect(() => container.resolve('A')).toThrow('Circular dependency detected')
  })

  it('circular error shows the dependency chain', () => {
    const container = new Container()
    container.singleton('X', () => container.resolve('Y'))
    container.singleton('Y', () => container.resolve('Z'))
    container.singleton('Z', () => container.resolve('X'))

    try {
      container.resolve('X')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('X → Y → Z → X')
      expect(msg).toContain('Circular dependency')
    }
  })

  it('does not false-positive on diamond dependencies', () => {
    const container = new Container()
    container.singleton('Shared', () => ({ value: 42 }))
    container.singleton('A', () => ({ shared: container.resolve('Shared') }))
    container.singleton('B', () => ({
      a: container.resolve('A'),
      shared: container.resolve('Shared'),
    }))

    // B depends on A and Shared; A depends on Shared — diamond, not circular
    const b = container.resolve<{ a: { shared: { value: number } }; shared: { value: number } }>(
      'B',
    )
    expect(b.a.shared.value).toBe(42)
    expect(b.shared.value).toBe(42)
  })
})

describe('container > has & size', () => {
  it('checks if token exists', () => {
    const container = new Container()
    container.singleton('a', () => 1)
    expect(container.has('a')).toBe(true)
    expect(container.has('b')).toBe(false)
  })

  it('reports size', () => {
    const container = new Container()
    expect(container.size).toBe(0)
    container.singleton('a', () => 1)
    container.bind('b', () => 2)
    expect(container.size).toBe(2)
  })
})

describe('container > autoConstruct without decorator metadata (dev loader)', () => {
  // The ream dev loader (esbuild/tsx) does NOT emit `design:paramtypes`. Since
  // the transpiler used for tests varies (esbuild locally, metadata-emitting in
  // CI), these tests `Reflect.deleteMetadata` to reproduce the metadata-less dev
  // condition DETERMINISTICALLY. Regression for the DI outage where the container
  // silently `new Class()`-d with undefined deps.
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('resolves constructor deps via @Inject tokens even without design:paramtypes', () => {
    container.singleton('db', () => ({ dialect: 'sqlite' }))

    @Service()
    class Repo {
      db: { dialect: string }
      constructor(db: { dialect: string }) {
        this.db = db
      }
    }
    // Apply the @Inject('db') parameter decorator imperatively. biome's parser
    // does not accept parameter-decorator SYNTAX, but the runtime effect — the
    // inject-token map at index 0 — is identical to `constructor(@Inject('db') db)`.
    Inject('db')(Repo, undefined, 0)
    // Force the metadata-less condition deterministically (a transpiler that
    // DOES emit design:paramtypes would otherwise resolve via the normal path).
    Reflect.deleteMetadata('design:paramtypes', Repo)

    const repo = container.make<Repo>(Repo)
    expect(repo.db).toEqual({ dialect: 'sqlite' })
  })

  it('throws CONTAINER_MISSING_METADATA instead of constructing with undefined deps', () => {
    @Service()
    class NeedsDeps {
      captured: unknown
      constructor(db: unknown) {
        this.captured = db
      }
    }
    // Simulate a dev loader that doesn't emit decorator metadata.
    Reflect.deleteMetadata('design:paramtypes', NeedsDeps)

    expect(() => container.make(NeedsDeps)).toThrow(/no dependency metadata/)
  })

  it('still constructs a genuine zero-argument class', () => {
    @Service()
    class NoDeps {
      value = 42
    }

    expect(container.make<NoDeps>(NoDeps).value).toBe(42)
  })
})

describe('container > fold-parity additions', () => {
  let container: InstanceType<typeof Container>
  beforeEach(() => {
    container = new Container()
  })

  it('alias() forwards resolution to the target binding', () => {
    class Database {}
    container.singleton(Database, () => new Database())
    container.alias('db', Database)
    expect(container.resolve('db')).toBeInstanceOf(Database)
    expect(container.has('db')).toBe(true)
  })

  it('hasAllBindings() is true only when every token resolves', () => {
    container.singleton('a', () => 1)
    container.singleton('b', () => 2)
    expect(container.hasAllBindings(['a', 'b'])).toBe(true)
    expect(container.hasAllBindings(['a', 'missing'])).toBe(false)
  })

  it('make() fills constructor slots from runtimeValues by index', () => {
    class Controller {
      constructor(
        readonly req: { url: string },
        readonly res: { code: number },
      ) {}
    }
    const req = { url: '/x' }
    const res = { code: 200 }
    const ctrl = container.make<Controller>(Controller, [req, res])
    expect(ctrl.req).toBe(req)
    expect(ctrl.res).toBe(res)
  })

  it('does not auto-construct a primitive-typed param — a default value fills the slot', () => {
    @Service()
    class WithDefault {
      constructor(readonly name: string = 'fallback') {}
    }
    // String is not injectable → the slot is left undefined → the constructor
    // default kicks in, instead of the old confusing "auto-construct String" error.
    expect(() => container.make(WithDefault)).not.toThrow()
    expect(container.make<WithDefault>(WithDefault).name).toBe('fallback')
  })
})

describe('container > resolving() hooks', () => {
  it('runs a hook on construction (for lazy init / decoration)', () => {
    const container = new Container()
    const seen: string[] = []
    class Db {
      connected = false
    }
    container.singleton(Db, () => new Db())
    container.resolving(Db, (value) => {
      seen.push('resolved')
      ;(value as Db).connected = true
    })
    const db = container.resolve<Db>(Db)
    expect(db.connected).toBe(true)
    // Singleton → hook runs once even across resolves.
    container.resolve(Db)
    expect(seen).toEqual(['resolved'])
  })
})

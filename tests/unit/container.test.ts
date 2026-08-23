import 'reflect-metadata'
import { beforeEach, describe, expect, it } from 'vitest'
import { Container, Inject, Service } from '../../src/index.js'

describe('container > basic resolution', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('resolves a singleton binding', async () => {
    let callCount = 0
    container.singleton('config', async () => {
      callCount++
      return { dbHost: 'localhost' }
    })

    const config1 = await container.resolve<{ dbHost: string }>('config')
    const config2 = await container.resolve<{ dbHost: string }>('config')

    expect(config1.dbHost).toBe('localhost')
    expect(config1).toBe(config2) // Same instance
    expect(callCount).toBe(1) // Factory called once
  })

  it('resolves a transient binding (new instance each time)', async () => {
    let callCount = 0
    container.bind('dto', async () => {
      callCount++
      return { id: callCount }
    })

    const dto1 = await container.resolve<{ id: number }>('dto')
    const dto2 = await container.resolve<{ id: number }>('dto')

    expect(dto1.id).toBe(1)
    expect(dto2.id).toBe(2)
    expect(dto1).not.toBe(dto2)
  })

  it('throws on unregistered token', async () => {
    await expect(container.resolve('nonexistent')).rejects.toThrow('No binding found')
  })
})

describe('container > @Service() auto-resolution', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('auto-resolves a @Service() decorated class', async () => {
    @Service()
    class GreetingService {
      greet(name: string) {
        return `Hello, ${name}!`
      }
    }

    const service = await container.resolve<InstanceType<typeof GreetingService>>(GreetingService)
    expect(service.greet('Ream')).toBe('Hello, Ream!')
  })

  it('resolves with explicit factory that has dependencies', async () => {
    @Service()
    class Logger {
      log(msg: string) {
        return msg
      }
    }

    container.singleton('OrderService', async () => {
      const logger = await container.resolve<InstanceType<typeof Logger>>(Logger)
      return { logger }
    })

    const service = await container.resolve<{ logger: InstanceType<typeof Logger> }>('OrderService')
    expect(service.logger).toBeInstanceOf(Logger)
    expect(service.logger.log('test')).toBe('test')
  })

  it('singleton scope returns same instance', async () => {
    @Service({ scope: 'singleton' })
    class SingletonService {
      id = Math.random()
    }

    const a = await container.resolve<InstanceType<typeof SingletonService>>(SingletonService)
    const b = await container.resolve<InstanceType<typeof SingletonService>>(SingletonService)
    expect(a).toBe(b)
    expect(a.id).toBe(b.id)
  })

  it('transient scope returns different instances', async () => {
    @Service({ scope: 'transient' })
    class TransientService {
      id = Math.random()
    }

    const a = await container.resolve<InstanceType<typeof TransientService>>(TransientService)
    const b = await container.resolve<InstanceType<typeof TransientService>>(TransientService)
    expect(a).not.toBe(b)
    expect(a.id).not.toBe(b.id)
  })
})

describe('container > override', () => {
  let container: InstanceType<typeof Container>

  beforeEach(() => {
    container = new Container()
  })

  it('override replaces a binding', async () => {
    container.singleton('db', async () => ({ type: 'postgres' }))

    const real = await container.resolve<{ type: string }>('db')
    expect(real.type).toBe('postgres')

    container.override('db', { type: 'fake' })
    const fake = await container.resolve<{ type: string }>('db')
    expect(fake.type).toBe('fake')
  })

  it('restore clears overrides', async () => {
    container.singleton('db', async () => ({ type: 'postgres' }))
    container.override('db', { type: 'fake' })

    expect((await container.resolve<{ type: string }>('db')).type).toBe('fake')

    container.restore()
    expect((await container.resolve<{ type: string }>('db')).type).toBe('postgres')
  })

  it('stacked overrides — last override wins', async () => {
    container.singleton('db', async () => ({ type: 'postgres' }))
    container.override('db', { type: 'sqlite' })
    container.override('db', { type: 'memory' })

    expect((await container.resolve<{ type: string }>('db')).type).toBe('memory')

    container.restore()
    expect((await container.resolve<{ type: string }>('db')).type).toBe('postgres')
  })

  it('multiple overrides on different bindings', async () => {
    container.singleton('db', async () => ({ type: 'postgres' }))
    container.singleton('cache', async () => ({ type: 'redis' }))

    container.override('db', { type: 'sqlite' })
    container.override('cache', { type: 'memory' })

    expect((await container.resolve<{ type: string }>('db')).type).toBe('sqlite')
    expect((await container.resolve<{ type: string }>('cache')).type).toBe('memory')

    container.restore()
    expect((await container.resolve<{ type: string }>('db')).type).toBe('postgres')
    expect((await container.resolve<{ type: string }>('cache')).type).toBe('redis')
  })

  it('parallel isolation — separate container instances', async () => {
    const c1 = new Container()
    const c2 = new Container()

    c1.singleton('db', async () => ({ type: 'postgres' }))
    c2.singleton('db', async () => ({ type: 'postgres' }))

    c1.override('db', { type: 'fake-1' })
    c2.override('db', { type: 'fake-2' })

    // Each container has its own override
    expect((await c1.resolve<{ type: string }>('db')).type).toBe('fake-1')
    expect((await c2.resolve<{ type: string }>('db')).type).toBe('fake-2')

    // Restoring one doesn't affect the other
    c1.restore()
    expect((await c1.resolve<{ type: string }>('db')).type).toBe('postgres')
    expect((await c2.resolve<{ type: string }>('db')).type).toBe('fake-2')
  })

  it('restore preserves singleton identity (M7)', async () => {
    let factoryCalls = 0
    container.singleton('db', async () => {
      factoryCalls++
      return { id: factoryCalls }
    })

    const original = await container.resolve<{ id: number }>('db')
    expect(factoryCalls).toBe(1)

    container.override('db', { id: 999 })
    expect((await container.resolve<{ id: number }>('db')).id).toBe(999)

    container.restore('db')
    const after = await container.resolve<{ id: number }>('db')
    // Same instance handed back — factory NOT re-invoked.
    expect(after).toBe(original)
    expect(factoryCalls).toBe(1)
  })

  it('restore() with no args also preserves singleton identity', async () => {
    container.singleton('a', async () => ({ tag: 'a' }))
    container.singleton('b', async () => ({ tag: 'b' }))
    const a = await container.resolve('a')
    const b = await container.resolve('b')

    container.override('a', { tag: 'fake-a' })
    container.override('b', { tag: 'fake-b' })

    container.restore()

    expect(await container.resolve('a')).toBe(a)
    expect(await container.resolve('b')).toBe(b)
  })

  it('override on a token with no prior singleton clears cleanly on restore', async () => {
    // No singleton registered → override sets the only value, restore wipes it
    container.override('orphan', 'fake')
    expect(await container.resolve('orphan')).toBe('fake')

    container.restore('orphan')
    await expect(container.resolve('orphan')).rejects.toThrow(/No binding found/)
  })

  it('rejects Symbol.for with a reserved description (M9)', async () => {
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

  it('resolves named interface binding via explicit factory', async () => {
    interface PaymentGateway {
      charge(amount: number): string
    }

    class StripeGateway implements PaymentGateway {
      charge(amount: number) {
        return `Charged $${amount} via Stripe`
      }
    }

    container.singleton('PaymentGateway', () => new StripeGateway())

    container.singleton('OrderService', async () => {
      const payment = await container.resolve<PaymentGateway>('PaymentGateway')
      return { payment }
    })

    const service = await container.resolve<{ payment: PaymentGateway }>('OrderService')
    expect(service.payment.charge(42)).toBe('Charged $42 via Stripe')
  })

  it('override named binding for testing', async () => {
    container.singleton('PaymentGateway', async () => ({ charge: () => 'real' }))
    expect((await container.resolve<{ charge: () => string }>('PaymentGateway')).charge()).toBe(
      'real',
    )

    container.override('PaymentGateway', { charge: () => 'fake' })
    expect((await container.resolve<{ charge: () => string }>('PaymentGateway')).charge()).toBe(
      'fake',
    )
  })
})

describe('container > circular dependency detection', () => {
  it('detects circular dependency and throws with clear message', async () => {
    const container = new Container()

    container.singleton('A', async () => {
      await container.resolve('B') // A depends on B
      return { name: 'A' }
    })

    container.singleton('B', async () => {
      await container.resolve('A') // B depends on A — circular!
      return { name: 'B' }
    })

    await expect(container.resolve('A')).rejects.toThrow('Circular dependency detected')
  })

  it('circular error shows the dependency chain', async () => {
    const container = new Container()
    container.singleton('X', async () => await container.resolve('Y'))
    container.singleton('Y', async () => await container.resolve('Z'))
    container.singleton('Z', async () => await container.resolve('X'))

    try {
      await container.resolve('X')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('X → Y → Z → X')
      expect(msg).toContain('Circular dependency')
    }
  })

  it('does not false-positive on diamond dependencies', async () => {
    const container = new Container()
    container.singleton('Shared', async () => ({ value: 42 }))
    container.singleton('A', async () => ({ shared: await container.resolve('Shared') }))
    container.singleton('B', async () => ({
      a: await container.resolve('A'),
      shared: await container.resolve('Shared'),
    }))

    // B depends on A and Shared; A depends on Shared — diamond, not circular
    const b = await container.resolve<{
      a: { shared: { value: number } }
      shared: { value: number }
    }>('B')
    expect(b.a.shared.value).toBe(42)
    expect(b.shared.value).toBe(42)
  })
})

describe('container > has & size', () => {
  it('checks if token exists', async () => {
    const container = new Container()
    container.singleton('a', () => 1)
    expect(container.has('a')).toBe(true)
    expect(container.has('b')).toBe(false)
  })

  it('reports size', async () => {
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

  it('resolves constructor deps via @Inject tokens even without design:paramtypes', async () => {
    container.singleton('db', async () => ({ dialect: 'sqlite' }))

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

    const repo = await container.make<Repo>(Repo)
    expect(repo.db).toEqual({ dialect: 'sqlite' })
  })

  it('throws CONTAINER_MISSING_METADATA instead of constructing with undefined deps', async () => {
    @Service()
    class NeedsDeps {
      captured: unknown
      constructor(db: unknown) {
        this.captured = db
      }
    }
    // Simulate a dev loader that doesn't emit decorator metadata.
    Reflect.deleteMetadata('design:paramtypes', NeedsDeps)

    await expect(container.make(NeedsDeps)).rejects.toThrow(/no dependency metadata/)
  })

  it('still constructs a genuine zero-argument class', async () => {
    @Service()
    class NoDeps {
      value = 42
    }

    expect((await container.make<NoDeps>(NoDeps)).value).toBe(42)
  })
})

describe('container > fold-parity additions', () => {
  let container: InstanceType<typeof Container>
  beforeEach(() => {
    container = new Container()
  })

  it('alias() forwards resolution to the target binding', async () => {
    class Database {}
    container.singleton(Database, () => new Database())
    container.alias('db', Database)
    expect(await container.resolve('db')).toBeInstanceOf(Database)
    expect(container.has('db')).toBe(true)
  })

  it('hasAllBindings() is true only when every token resolves', async () => {
    container.singleton('a', () => 1)
    container.singleton('b', () => 2)
    expect(container.hasAllBindings(['a', 'b'])).toBe(true)
    expect(container.hasAllBindings(['a', 'missing'])).toBe(false)
  })

  it('make() fills constructor slots from runtimeValues by index', async () => {
    class Controller {
      constructor(
        readonly req: { url: string },
        readonly res: { code: number },
      ) {}
    }
    const req = { url: '/x' }
    const res = { code: 200 }
    const ctrl = await container.make<Controller>(Controller, [req, res])
    expect(ctrl.req).toBe(req)
    expect(ctrl.res).toBe(res)
  })

  it('does not auto-construct a primitive-typed param — a default value fills the slot', async () => {
    @Service()
    class WithDefault {
      constructor(readonly name: string = 'fallback') {}
    }
    // String is not injectable → the slot is left undefined → the constructor
    // default kicks in, instead of the old confusing "auto-construct String" error.
    await expect(container.make(WithDefault)).resolves.not.toThrow()
    expect((await container.make<WithDefault>(WithDefault)).name).toBe('fallback')
  })
})

describe('container > resolving() hooks', () => {
  it('runs a hook on construction (for lazy init / decoration)', async () => {
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
    const db = await container.resolve<Db>(Db)
    expect(db.connected).toBe(true)
    // Singleton → hook runs once even across resolves.
    await container.resolve(Db)
    expect(seen).toEqual(['resolved'])
  })
})

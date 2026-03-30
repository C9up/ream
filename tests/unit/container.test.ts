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

    container.override('db', () => ({ type: 'fake' }))
    const fake = container.resolve<{ type: string }>('db')
    expect(fake.type).toBe('fake')
  })

  it('restore clears overrides', () => {
    container.singleton('db', () => ({ type: 'postgres' }))
    container.override('db', () => ({ type: 'fake' }))

    expect(container.resolve<{ type: string }>('db').type).toBe('fake')

    container.restore()
    expect(container.resolve<{ type: string }>('db').type).toBe('postgres')
  })

  it('stacked overrides — last override wins', () => {
    container.singleton('db', () => ({ type: 'postgres' }))
    container.override('db', () => ({ type: 'sqlite' }))
    container.override('db', () => ({ type: 'memory' }))

    expect(container.resolve<{ type: string }>('db').type).toBe('memory')

    container.restore()
    expect(container.resolve<{ type: string }>('db').type).toBe('postgres')
  })

  it('multiple overrides on different bindings', () => {
    container.singleton('db', () => ({ type: 'postgres' }))
    container.singleton('cache', () => ({ type: 'redis' }))

    container.override('db', () => ({ type: 'sqlite' }))
    container.override('cache', () => ({ type: 'memory' }))

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

    c1.override('db', () => ({ type: 'fake-1' }))
    c2.override('db', () => ({ type: 'fake-2' }))

    // Each container has its own override
    expect(c1.resolve<{ type: string }>('db').type).toBe('fake-1')
    expect(c2.resolve<{ type: string }>('db').type).toBe('fake-2')

    // Restoring one doesn't affect the other
    c1.restore()
    expect(c1.resolve<{ type: string }>('db').type).toBe('postgres')
    expect(c2.resolve<{ type: string }>('db').type).toBe('fake-2')
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

    container.override('PaymentGateway', () => ({ charge: () => 'fake' }))
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
    const b = container.resolve<{ a: { shared: { value: number } }; shared: { value: number } }>('B')
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

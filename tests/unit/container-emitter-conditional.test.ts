/**
 * `@adonisjs/fold` surface the container lacked: an emitter told about every
 * resolution (`container_binding:resolved`), and conditional bindings chosen
 * per resolution by a predicate (`container.if()` / `conditionalBinding`).
 */

import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'

function recorder() {
  const events: Array<{ event: string; data: unknown }> = []
  return {
    events,
    emitter: {
      emit(event: string, data: unknown) {
        events.push({ event, data })
      },
    },
  }
}

class Clock {}
abstract class PaymentGateway {
  abstract name: string
}
class StripeGateway extends PaymentGateway {
  name = 'stripe'
}
class BetaGateway extends PaymentGateway {
  name = 'beta'
}

describe('Container > emitter', () => {
  it('emits container_binding:resolved for a binding and for a constructed class', async () => {
    const { events, emitter } = recorder()
    const container = new Container().useEmitter(emitter)
    container.bind('greeting', () => 'hello')
    const greeting = await container.make('greeting')
    const clock = await container.make(Clock)
    expect(events).toEqual([
      { event: 'container_binding:resolved', data: { binding: 'greeting', value: greeting } },
      { event: 'container_binding:resolved', data: { binding: Clock, value: clock } },
    ])
  })

  it('takes the emitter as a constructor option, and sees resolver values too', async () => {
    const { events, emitter } = recorder()
    const container = new Container({ emitter })
    const resolver = container.createResolver()
    resolver.bindValue('ctx', { id: 1 })
    await resolver.make('ctx')
    expect(events).toEqual([
      { event: 'container_binding:resolved', data: { binding: 'ctx', value: { id: 1 } } },
    ])
  })

  it('emits for every dependency of a class, inner first', async () => {
    const { events, emitter } = recorder()
    class Service {
      constructor(readonly clock: Clock) {}
    }
    // What tsc emits for a decorated class (vitest's transform does not).
    Reflect.defineMetadata('design:paramtypes', [Clock], Service)
    await new Container({ emitter }).make(Service)
    expect(events.map((entry) => entry.data)).toMatchObject([
      { binding: Clock },
      { binding: Service },
    ])
  })

  it('never lets a throwing or rejecting emitter break a resolution', async () => {
    const container = new Container().useEmitter({
      emit() {
        throw new Error('listener down')
      },
    })
    container.bind('a', () => 1)
    await expect(container.make('a')).resolves.toBe(1)

    const rejecting = new Container().useEmitter({
      emit: () => Promise.reject(new Error('async down')),
    })
    rejecting.bind('b', () => 2)
    await expect(rejecting.make('b')).resolves.toBe(2)
  })
})

describe('Container > conditional bindings', () => {
  it('picks the first binding whose condition holds, in registration order', async () => {
    const container = new Container()
    let beta = false
    container.bind(PaymentGateway, () => new StripeGateway())
    container.if(() => beta).bind(PaymentGateway, () => new BetaGateway())
    container.if(() => true).bind(PaymentGateway, () => ({ name: 'catch-all' }))

    expect(await container.make<PaymentGateway>(PaymentGateway)).toMatchObject({
      name: 'catch-all',
    })
    beta = true
    expect(await container.make<PaymentGateway>(PaymentGateway)).toMatchObject({ name: 'beta' })
  })

  it('falls back to the regular binding when no condition holds', async () => {
    const container = new Container()
    container.bind(PaymentGateway, () => new StripeGateway())
    container.if(async () => false).bind(PaymentGateway, () => new BetaGateway())
    expect(await container.make<PaymentGateway>(PaymentGateway)).toBeInstanceOf(StripeGateway)
  })

  it('hands the condition the resolver, the runtime values and the asking class', async () => {
    const seen: unknown[] = []
    const container = new Container()
    container.conditionalBinding(
      (resolver, runtimeValues, parent) => {
        seen.push([typeof resolver.make, runtimeValues, parent])
        return true
      },
      'tenant',
      () => 'acme',
    )
    class Report {
      constructor(readonly clock: Clock) {}
    }
    Reflect.defineMetadata('design:paramtypes', [Clock], Report)
    container.conditionalBinding(
      (resolver, runtimeValues, parent) => {
        seen.push([typeof resolver.make, runtimeValues, parent])
        return false
      },
      Clock,
      () => new Clock(),
    )
    await container.make('tenant', ['x'])
    await container.make(Report)
    expect(seen).toEqual([
      ['function', ['x'], null],
      // A dependency of a class gets no runtime values, and its asker.
      ['function', undefined, Report],
    ])
  })

  it('caches a conditional singleton per branch', async () => {
    const container = new Container()
    let flag = true
    let builds = 0
    container.if(() => flag).singleton('mailer', () => ({ build: ++builds, kind: 'preview' }))
    container.singleton('mailer', () => ({ build: ++builds, kind: 'smtp' }))

    const first = await container.make('mailer')
    expect(await container.make('mailer')).toBe(first)
    flag = false
    const regular = await container.make('mailer')
    expect(regular).toMatchObject({ kind: 'smtp' })
    flag = true
    expect(await container.make('mailer')).toBe(first)
    expect(builds).toBe(2)
  })

  it('builds a concurrently requested conditional singleton once', async () => {
    const container = new Container()
    let builds = 0
    container
      .if(() => true)
      .singleton('pool', async () => {
        builds += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { id: builds }
      })
    const [a, b] = await Promise.all([container.make('pool'), container.make('pool')])
    expect(a).toBe(b)
    expect(builds).toBe(1)
  })

  it('does not cache app-wide a conditional singleton built from a request value', async () => {
    const container = new Container()
    container
      .if(() => true)
      .singleton('scoped', async (resolver) => ({ ctx: await resolver.make('ctx') }))
    const first = container.createResolver()
    first.bindValue('ctx', 'request-1')
    const second = container.createResolver()
    second.bindValue('ctx', 'request-2')
    expect(await first.make('scoped')).toEqual({ ctx: 'request-1' })
    expect(await second.make('scoped')).toEqual({ ctx: 'request-2' })
  })

  it('runs resolving hooks on a conditional value, once for a singleton', async () => {
    const container = new Container()
    let hooks = 0
    container.resolving('svc', () => {
      hooks += 1
    })
    container.if(() => true).singleton('svc', () => ({}))
    await container.make('svc')
    await container.make('svc')
    expect(hooks).toBe(1)
  })

  it('lets a swap win over a conditional binding, and counts as a binding', async () => {
    const container = new Container()
    container.if(() => true).bind('svc', () => 'conditional')
    expect(container.hasBinding('svc')).toBe(true)
    expect(container.has('svc')).toBe(true)
    container.swap('svc', () => 'swapped')
    expect(await container.make('svc')).toBe('swapped')
    container.restore('svc')
    expect(await container.make('svc')).toBe('conditional')
  })

  it('says so when only conditional bindings exist and none matched', async () => {
    const container = new Container()
    container.if(() => false).bind('svc', () => 'never')
    await expect(container.make('svc')).rejects.toMatchObject({
      code: 'E_CONTAINER_NOT_FOUND',
      help: expect.stringMatching(/conditional binding/),
    })
  })
})

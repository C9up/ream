import { beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../../src/events/native.js'

let bus: InstanceType<typeof EventBus>

beforeEach(() => {
  bus = new EventBus()
})

describe('events > emit & subscribe', () => {
  it('emits event and subscriber receives it (MVP 0 gate test)', async () => {
    const received: unknown[] = []

    bus.subscribe('order.created', (eventJson: string) => {
      received.push(JSON.parse(eventJson))
    })

    const eventJson = await bus.emit('order.created', JSON.stringify({ orderId: '123' }))
    const event = JSON.parse(eventJson)

    // Wait for async callback delivery
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(event.name).toBe('order.created')
    expect(event.id).toBeDefined()
    expect(event.correlationId).toBe(event.id)
    expect(received.length).toBe(1)
    expect((received[0] as Record<string, unknown>).name).toBe('order.created')
  })

  it('wildcard subscription matches pattern', async () => {
    const received: string[] = []

    bus.subscribe('order.*', (eventJson: string) => {
      const event = JSON.parse(eventJson)
      received.push(event.name)
    })

    await bus.emit('order.created', '{}')
    await bus.emit('order.paid', '{}')
    await bus.emit('payment.received', '{}') // Should NOT match

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(received).toContain('order.created')
    expect(received).toContain('order.paid')
    expect(received).not.toContain('payment.received')
    expect(received.length).toBe(2)
  })

  it('multiple subscribers all receive the event', async () => {
    let count = 0

    bus.subscribe('test.event', () => {
      count++
    })
    bus.subscribe('test.event', () => {
      count++
    })
    bus.subscribe('test.event', () => {
      count++
    })

    await bus.emit('test.event', '{}')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(count).toBe(3)
  })

  it('event has correlation ID and timestamp', async () => {
    const eventJson = await bus.emit('test', '{}')
    const event = JSON.parse(eventJson)

    expect(event.id).toBeDefined()
    expect(event.correlationId).toBeDefined()
    expect(event.timestamp).toBeDefined()
    expect(event.nodeId).toBe('local')
  })
})

describe('events > independence', () => {
  it('multiple bus instances are independent (not singleton)', async () => {
    const bus2 = new EventBus()
    let bus1Count = 0
    let bus2Count = 0

    bus.subscribe('test', () => {
      bus1Count++
    })
    bus2.subscribe('test', () => {
      bus2Count++
    })

    await bus.emit('test', '{}')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(bus1Count).toBe(1)
    expect(bus2Count).toBe(0) // bus2 should NOT receive bus1's events
  })
})

describe('events > unsubscribe', () => {
  it('unsubscribe stops receiving events', async () => {
    let count = 0
    const subId = bus.subscribe('test', () => {
      count++
    })

    await bus.emit('test', '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(count).toBe(1)

    await bus.unsubscribe(subId)
    await bus.emit('test', '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(count).toBe(1) // Should not increment after unsub
  })
})

describe('events > subscription count', () => {
  it('tracks active subscriptions', async () => {
    expect(await bus.subscriptionCount()).toBe(0)

    const sub1 = bus.subscribe('a', () => {})
    bus.subscribe('b.*', () => {})
    expect(await bus.subscriptionCount()).toBe(2)

    await bus.unsubscribe(sub1)
    expect(await bus.subscriptionCount()).toBe(1)
  })
})

describe('events > request/reply', () => {
  it('request gets a response from handler', async () => {
    const reqBus = new EventBus()
    reqBus.onRequest('order.validate', (_eventJson: string, reply: (r: string) => void) => {
      reply(JSON.stringify({ valid: true }))
    })

    const response = await reqBus.request('order.validate', JSON.stringify({ amount: 42 }))
    expect(response).toBeDefined()
  })

  it('request throws on no handler', async () => {
    const reqBus = new EventBus()
    await expect(reqBus.request('nonexistent', '{}')).rejects.toThrow(Error)
  })
})

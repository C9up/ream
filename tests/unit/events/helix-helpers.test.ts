import { describe, expect, it } from 'vitest'
// The shipped helpers, not the copy of them that sits beside this file:
// `tests/unit/events/helpers.js` duplicates `src/events/helix/helpers.ts`
// export for export, so this suite was exercising a second implementation
// while the one users import went untested by it.
import {
  assertEmitted,
  assertNotEmitted,
  collect,
  fake,
  waitForEvent,
} from '../../../src/events/helix/helpers.js'
import { EventBus } from '../../../src/events/native.js'
import { defined } from '../../__helpers__/defined.js'

describe('helix > collect()', () => {
  it('captures emitted events into an array', async () => {
    const bus = new EventBus()
    const { events, subId } = collect(bus, 'order.created')

    bus.emit('order.created', JSON.stringify({ orderId: '1' }))
    bus.emit('order.created', JSON.stringify({ orderId: '2' }))
    bus.emit('order.paid', '{}') // Should NOT be collected

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(events.length).toBe(2)
    expect(defined(events[0]).name).toBe('order.created')
    expect(defined(events[1]).name).toBe('order.created')
    expect(subId).toBeGreaterThan(0)
  })

  it('collect with wildcard captures matching events', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', '{}')
    bus.emit('order.paid', '{}')
    bus.emit('payment.received', '{}')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(events.length).toBe(2)
  })
})

describe('helix > fake()', () => {
  it('intercepts events into an array', async () => {
    const bus = new EventBus()
    const faked = fake(bus, 'mail.send')

    bus.emit('mail.send', JSON.stringify({ to: 'test@example.com' }))

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(faked.events.length).toBe(1)
    expect(defined(faked.events[0]).name).toBe('mail.send')
  })
})

describe('helix > assertEmitted()', () => {
  it('passes when event was emitted', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', JSON.stringify({ orderId: '123' }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should not throw
    assertEmitted(events, 'order.created')
  })

  it('throws when event was NOT emitted', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(() => assertEmitted(events, 'order.deleted')).toThrow('HELIX_ASSERT_EMITTED')
  })

  it('matches partial payload', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', JSON.stringify({ orderId: '123', total: 42.5, status: 'pending' }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Partial match — only checking orderId
    assertEmitted(events, 'order.created', { orderId: '123' })
  })

  it('throws when payload does not match', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', JSON.stringify({ orderId: '123' }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(() => assertEmitted(events, 'order.created', { orderId: '999' })).toThrow(
      'no payload matched',
    )
  })

  it('handles nested payload matching', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'user.*')

    bus.emit(
      'user.updated',
      JSON.stringify({
        userId: '1',
        address: { city: 'Paris', country: 'FR' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    assertEmitted(events, 'user.updated', { address: { city: 'Paris' } })
  })
})

describe('helix > assertNotEmitted()', () => {
  it('passes when event was NOT emitted', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))

    assertNotEmitted(events, 'order.deleted')
  })

  it('throws when event WAS emitted', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(() => assertNotEmitted(events, 'order.created')).toThrow('HELIX_ASSERT_NOT_EMITTED')
  })
})

describe('helix > waitForEvent()', () => {
  it('resolves when event appears', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'payment.*')

    // Emit after a delay
    setTimeout(() => bus.emit('payment.received', JSON.stringify({ amount: 100 })), 20)

    const event = await waitForEvent(events, 'payment.received', {
      timeout: 2000,
    })
    expect(event.name).toBe('payment.received')
  })

  it('resolves with payload matching', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    setTimeout(() => {
      bus.emit('order.created', JSON.stringify({ orderId: '1' }))
      bus.emit('order.created', JSON.stringify({ orderId: '2' }))
    }, 20)

    const event = await waitForEvent(events, 'order.created', {
      timeout: 2000,
      payload: { orderId: '2' },
    })
    expect(event.name).toBe('order.created')
  })

  it('rejects on timeout with events received so far', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', '{}')

    await expect(waitForEvent(events, 'payment.received', { timeout: 100 })).rejects.toThrow(
      'HELIX_TIMEOUT',
    )
  })

  it('resolves immediately if event already in array', async () => {
    const bus = new EventBus()
    const { events } = collect(bus, 'order.*')

    bus.emit('order.created', '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Event already there — should resolve instantly
    const event = await waitForEvent(events, 'order.created', { timeout: 100 })
    expect(event.name).toBe('order.created')
  })
})

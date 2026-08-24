/**
 * `emit()` returns a promise and resolves once the listeners have finished, as
 * AdonisJS does — awaiting it is how a handler makes sure the work it triggered
 * happened before it answers. It used to be fire-and-forget, so a migrated
 * `await emitter.emit(...)` resolved immediately and the work raced the reply.
 */
import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../src/events/Emitter.js'
import { FakeBus } from '../../../src/events/testing/FakeBus.js'

function emitter(): Emitter {
  return new Emitter({
    emit: async () => {},
    on: () => {},
    request: async () => '',
  } as never)
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ream > awaitable emit', () => {
  it('resolves only once every listener has finished', async () => {
    const done: string[] = []
    const e = emitter()
    e.on('job', async () => {
      await tick(10)
      done.push('slow')
    })
    e.on('job', () => {
      done.push('fast')
    })

    await e.emit('job', {})
    expect(done.sort()).toEqual(['fast', 'slow'])
  })

  it('runs listeners in parallel', async () => {
    const e = emitter()
    const started = performance.now()
    e.on('job', async () => tick(30))
    e.on('job', async () => tick(30))
    await e.emit('job', {})
    // Serial would be ~60ms.
    expect(performance.now() - started).toBeLessThan(55)
  })

  it('emitSerial runs them one after another', async () => {
    const order: string[] = []
    const e = emitter()
    e.on('job', async () => {
      await tick(20)
      order.push('first')
    })
    e.on('job', () => {
      order.push('second')
    })
    await e.emitSerial('job', {})
    expect(order).toEqual(['first', 'second'])
  })

  it('one failing listener does not cancel the others', async () => {
    const ran: string[] = []
    const e = emitter()
    e.on('job', () => {
      throw new Error('subscriber blew up')
    })
    e.on('job', () => {
      ran.push('other')
    })
    await expect(e.emit('job', {})).resolves.toBeUndefined()
    expect(ran).toEqual(['other'])
  })
})

describe('ream > listener management', () => {
  it('once fires a single time', async () => {
    const listener = vi.fn()
    const e = emitter()
    e.once('job', listener)
    await e.emit('job', {})
    await e.emit('job', {})
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('off removes one listener', async () => {
    const kept = vi.fn()
    const dropped = vi.fn()
    const e = emitter()
    e.on('job', kept)
    e.on('job', dropped)
    e.off('job', dropped)
    await e.emit('job', {})
    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
  })

  it('listenIf registers only when the condition holds', async () => {
    const on = vi.fn()
    const off = vi.fn()
    const e = emitter()
    e.listenIf(true, 'job', on)
    e.listenIf(false, 'job', off)
    await e.emit('job', {})
    expect(on).toHaveBeenCalledTimes(1)
    expect(off).not.toHaveBeenCalled()
  })

  it('counts and clears listeners', async () => {
    const e = emitter()
    e.on('a', () => {})
    e.on('a', () => {})
    e.on('b', () => {})
    expect(e.listenerCount('a')).toBe(2)
    expect(e.listenerCount()).toBe(3)

    e.clearListeners('a')
    expect(e.listenerCount('a')).toBe(0)

    e.clearAllListeners()
    expect(e.listenerCount()).toBe(0)
  })
})

/**
 * Surface checked against `@adonisjs/events`' published `emitter.d.ts`:
 *
 *   on(...): UnsubscribeFunction
 *   onAny(listener): UnsubscribeFunction        // ONE argument, every event
 *
 * An audit also claimed wildcard listeners were never dispatched in-process.
 * They are — through the bus — and the last test pins that, because the private
 * `#wildcardListenersFor` returning `[]` reads like the opposite.
 */
describe('events > Emitter unsubscribe + onAny (AdonisJS parity)', () => {
  it('on() hands back an unsubscribe function', async () => {
    const e = new Emitter(new FakeBus())
    const seen: unknown[] = []
    const off = e.on('user:registered', (data) => seen.push(data))

    await e.emit('user:registered', { id: 1 })
    off()
    await e.emit('user:registered', { id: 2 })

    // Keeping the listener around just to pass it back to off() is the
    // boilerplate this return value removes.
    expect(seen).toEqual([{ id: 1 }])
  })

  it('the unsubscribe from on() also works for a class event', async () => {
    class OrderShipped {
      constructor(readonly id: number) {}
    }
    const e = new Emitter(new FakeBus())
    const seen: unknown[] = []
    const off = e.on(OrderShipped, (event) => seen.push(event))

    // Class events go through dispatchEvent (what BaseEvent#emit calls).
    await e.dispatchEvent(new OrderShipped(1))
    off()
    await e.dispatchEvent(new OrderShipped(2))

    expect(seen).toHaveLength(1)
  })

  it('onAny(listener) listens to every event, as in AdonisJS', async () => {
    const e = new Emitter(new FakeBus())
    const seen: string[] = []
    await e.onAny((name) => {
      seen.push(name)
    })

    await e.emit('order.placed', { id: 1 })
    await e.emit('user.created', { id: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(seen.sort()).toEqual(['order.placed', 'user.created'])
  })

  it('onAny(pattern, listener) filters — and DOES receive local emits', async () => {
    const e = new Emitter(new FakeBus())
    const seen: string[] = []
    await e.onAny('order.*', (name) => {
      seen.push(name)
    })

    await e.emit('order.placed', { id: 1 })
    await e.emit('user.created', { id: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(seen).toEqual(['order.placed'])
  })
})

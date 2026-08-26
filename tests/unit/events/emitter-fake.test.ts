/**
 * `fake()` / `restore()` and the events buffer — the AdonisJS testing surface
 * for events (`@adonisjs/events` `Emitter.fake`). Without it a migrated test
 * could not assert what an action announced without also running every
 * reaction to it.
 */
import { AssertionError } from 'node:assert'
import { describe, expect, it } from 'vitest'
import { BaseEvent, Emitter } from '../../../src/events/Emitter.js'
import { FakeBus } from '../../../src/events/testing/FakeBus.js'

function emitter(): { e: Emitter; bus: FakeBus } {
  const bus = new FakeBus()
  return { e: new Emitter(bus as never), bus }
}

describe('Emitter.fake', () => {
  it('keeps a faked event away from its listeners and from the bus', async () => {
    const { e, bus } = emitter()
    let ran = false
    e.on('user:registered', () => {
      ran = true
    })

    const events = e.fake(['user:registered'])
    await e.emit('user:registered', { id: 1 })

    expect(ran).toBe(false)
    expect(bus.getEmitted().length).toBe(0)
    events.assertEmitted('user:registered')
  })

  it('lets an event that was not faked through untouched', async () => {
    const { e } = emitter()
    let ran = false
    e.on('other', () => {
      ran = true
    })

    const events = e.fake(['user:registered'])
    await e.emit('other', {})

    expect(ran).toBe(true)
    events.assertNotEmitted('other')
  })

  it('fakes every event when called with no argument', async () => {
    const { e } = emitter()
    let ran = false
    e.on('anything', () => {
      ran = true
    })

    const events = e.fake()
    await e.emit('anything', {})

    expect(ran).toBe(false)
    expect(events.size()).toBe(1)
  })

  it('restores delivery', async () => {
    const { e } = emitter()
    let ran = false
    e.on('user:registered', () => {
      ran = true
    })

    e.fake(['user:registered'])
    e.restore()
    await e.emit('user:registered', {})

    expect(ran).toBe(true)
  })

  it('drops the previous buffer when faking again', async () => {
    const { e } = emitter()
    const first = e.fake()
    await e.emit('a', {})
    expect(first.size()).toBe(1)

    const second = e.fake()
    expect(second.size()).toBe(0)
    await e.emit('b', {})
    // The first buffer is detached: it stops growing.
    expect(first.size()).toBe(1)
    expect(second.size()).toBe(1)
  })

  it('fakes a class-based event by its class', async () => {
    class TaskDeclared extends BaseEvent {
      constructor(readonly title: string) {
        super()
      }
    }
    const { e } = emitter()
    let ran = false
    e.on(TaskDeclared, () => {
      ran = true
    })

    const events = e.fake([TaskDeclared])
    await e.dispatchEvent(new TaskDeclared('write it down'))

    expect(ran).toBe(false)
    events.assertEmitted(TaskDeclared)
  })

  it('emitSerial is faked too', async () => {
    const { e } = emitter()
    let ran = false
    e.on('seq', () => {
      ran = true
    })
    const events = e.fake()
    await e.emitSerial('seq', {})
    expect(ran).toBe(false)
    events.assertEmitted('seq')
  })

  it('restores when the buffer leaves a `using` block', async () => {
    const { e } = emitter()
    let ran = false
    e.on('scoped', () => {
      ran = true
    })

    {
      using events = e.fake()
      await e.emit('scoped', {})
      events.assertEmitted('scoped')
    }

    // A test that threw inside the block must not leave events faked.
    await e.emit('scoped', {})
    expect(ran).toBe(true)
  })
})

describe('EventsBuffer assertions', () => {
  it('finds an emission by payload', async () => {
    const { e } = emitter()
    const events = e.fake()
    await e.emit('order:placed', { total: 10 })
    await e.emit('order:placed', { total: 99 })

    events.assertEmitted<{ total: number }>('order:placed', ({ data }) => data.total === 99)
    expect(events.find<{ total: number }>('order:placed', ({ data }) => data.total === 5)).toBe(
      null,
    )
  })

  it('counts emissions', async () => {
    const { e } = emitter()
    const events = e.fake()
    await e.emit('ping', {})
    await e.emit('ping', {})

    events.assertEmittedCount('ping', 2)
    expect(() => events.assertEmittedCount('ping', 1)).toThrow(AssertionError)
  })

  it('reports what WAS emitted when an assertion fails', async () => {
    const { e } = emitter()
    const events = e.fake()
    await e.emit('actual:event', {})

    // The message has to name the miss, otherwise a failing test says only
    // "expected true to be false".
    expect(() => events.assertEmitted('missing:event')).toThrow(/missing:event/)
  })

  it('asserts nothing was emitted', async () => {
    const { e } = emitter()
    const events = e.fake()
    events.assertNoneEmitted()

    await e.emit('something', {})
    expect(() => events.assertNoneEmitted()).toThrow(AssertionError)
  })

  it('flushes without lifting the fake', async () => {
    const { e } = emitter()
    let ran = false
    e.on('x', () => {
      ran = true
    })
    const events = e.fake()
    await e.emit('x', {})
    events.flush()

    expect(events.size()).toBe(0)
    await e.emit('x', {})
    expect(ran).toBe(false)
    expect(events.size()).toBe(1)
  })
})

describe('Emitter wildcard subscriptions (AdonisJS shape)', () => {
  it('onAny hands back an unsubscribe function, not a raw handle', async () => {
    const { e } = emitter()
    const seen: string[] = []
    // AdonisJS returns `UnsubscribeFunction`. It used to resolve to the Rust
    // subscription id, which no migrated call site knows what to do with.
    const unsubscribe = await e.onAny((name) => {
      seen.push(name)
    })

    expect(typeof unsubscribe).toBe('function')
    await e.emit('a:b', {})
    expect(seen).toEqual(['a:b'])

    await unsubscribe()
    await e.emit('c:d', {})
    expect(seen).toEqual(['a:b'])
  })

  it('offAny takes the listener, as AdonisJS does', async () => {
    const { e } = emitter()
    const seen: string[] = []
    const listener = (name: string) => {
      seen.push(name)
    }
    await e.onAny(listener)
    await e.emit('one', {})

    expect(await e.offAny(listener)).toBe(e)
    await e.emit('two', {})
    expect(seen).toEqual(['one'])
  })

  it('offAny still accepts the bus handle it was given before', async () => {
    const { e } = emitter()
    // The numeric form is what crosses NAPI; dropping it would break the
    // unsubscribe function above, which closes over exactly that.
    await expect(e.offAny(9999)).resolves.toBe(e)
  })

  it('offAny on an unknown listener is a no-op, not a throw', async () => {
    const { e } = emitter()
    await expect(e.offAny(() => {})).resolves.toBe(e)
  })
})

describe('Emitter listener bookkeeping (AdonisJS shape)', () => {
  it('hasListeners with no argument asks about every event', () => {
    const { e } = emitter()
    expect(e.hasListeners()).toBe(false)
    e.on('something', () => {})
    expect(e.hasListeners()).toBe(true)
    expect(e.hasListeners('something')).toBe(true)
    expect(e.hasListeners('other')).toBe(false)
  })

  it('listenIf takes a thunk as well as a boolean', async () => {
    const { e } = emitter()
    let ran = 0
    e.listenIf(
      () => false,
      'flagged',
      () => {
        ran += 1
      },
    )
    e.listenIf(
      () => true,
      'flagged',
      () => {
        ran += 1
      },
    )
    await e.emit('flagged', {})
    expect(ran).toBe(1)
  })
})

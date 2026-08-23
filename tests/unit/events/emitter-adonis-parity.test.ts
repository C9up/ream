/**
 * `emit()` returns a promise and resolves once the listeners have finished, as
 * AdonisJS does — awaiting it is how a handler makes sure the work it triggered
 * happened before it answers. It used to be fire-and-forget, so a migrated
 * `await emitter.emit(...)` resolved immediately and the work raced the reply.
 */
import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../src/events/Emitter.js'

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

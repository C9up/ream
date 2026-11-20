/**
 * What a wildcard (`onAny`) listener receives, through the real Rust bus.
 *
 * - A listener that throws runs ONCE and its error goes to `onError`. One
 *   try/catch used to cover both the envelope parsing and the listener call,
 *   so a throwing listener was taken for an unreadable envelope and called
 *   again with the pattern and the raw JSON; its second throw left through the
 *   native callback as an uncaught exception, which ends the process.
 * - The listener gets the emitted value, not the JSON string the emitter
 *   serialized, and no `correlationId` key the caller did not put there.
 * - It runs with the correlation id active where the event was emitted, not
 *   the Rust event's own fresh uuid.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Emitter } from '../../../src/events/Emitter.js'
import { EventBus } from '../../../src/events/native.js'

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

const uncaught: unknown[] = []
const onUncaught = (error: unknown) => {
  uncaught.push(error)
}

afterEach(() => {
  process.off('uncaughtException', onUncaught)
  uncaught.length = 0
})

describe('events > onAny delivery through the native bus', () => {
  it('calls a throwing listener once and reports its error instead of crashing', async () => {
    process.on('uncaughtException', onUncaught)
    const emitter = new Emitter(new EventBus())
    const calls: Array<[string, unknown]> = []
    const reported: Array<[string, unknown]> = []
    emitter.onError((event, error) => reported.push([event, error]))
    await emitter.onAny('order.*', (name, data) => {
      calls.push([name, data])
      throw new Error('boom')
    })

    await emitter.emit('order.created', { id: 1 })
    await settle()

    expect(calls).toEqual([['order.created', { id: 1 }]])
    expect(reported).toHaveLength(1)
    expect(reported[0]?.[0]).toBe('order.created')
    expect(reported[0]?.[1]).toBeInstanceOf(Error)
    expect(uncaught).toEqual([])
    emitter.clearAllListeners()
  })

  it('reports a listener that rejects, once', async () => {
    const emitter = new Emitter(new EventBus())
    const reported: string[] = []
    emitter.onError((event) => reported.push(event))
    await emitter.onAny('job.*', async () => {
      throw new Error('later')
    })
    await emitter.emit('job.done', {})
    await settle()
    expect(reported).toEqual(['job.done'])
    emitter.clearAllListeners()
  })

  it('hands over the emitted value and runs under the emit-site correlation id', async () => {
    const emitter = new Emitter(new EventBus())
    const seen: Array<{ name: string; data: unknown; correlationId: string | undefined }> = []
    await emitter.onAny('order.*', (name, data) => {
      seen.push({ name, data, correlationId: emitter.getCorrelationId() })
    })

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        emitter.setCorrelationId('trace-abc')
        void emitter.emit('order.created', { id: 1 }).then(() => resolve())
      })
    })
    await settle()

    expect(seen).toEqual([{ name: 'order.created', data: { id: 1 }, correlationId: 'trace-abc' }])
    emitter.clearAllListeners()
  })

  it('delivers primitives, arrays and an event emitted without data as such', async () => {
    const emitter = new Emitter(new EventBus())
    const seen: unknown[] = []
    await emitter.onAny('v.*', (_name, data) => {
      seen.push(data)
    })
    await emitter.emit('v.number', 42)
    await settle(20)
    await emitter.emit('v.list', [1, 'two'])
    await settle(20)
    await emitter.emit('v.none', undefined)
    await settle()
    expect(seen).toEqual([42, [1, 'two'], undefined])
    emitter.clearAllListeners()
  })
})

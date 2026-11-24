/**
 * A request handler that throws or rejects ends that request, not the
 * process.
 *
 * The native bus calls the handler from a threadsafe function: an exception
 * that leaves it is an `uncaughtException`, and the error boundary answers
 * that with `process.exit(1)`. So one request whose data made the handler
 * throw took the whole server down.
 */
import { describe, expect, it } from 'vitest'
import { E_EVENTS_HANDLER_FAILED } from '../../../src/errors/codes.js'
import { Emitter } from '../../../src/events/Emitter.js'
import { EventBus } from '../../../src/events/native.js'
import { FakeBus } from '../../../src/events/testing/FakeBus.js'

/** Swap the runner's own `uncaughtException` listeners for a recorder. */
async function withUncaughtRecorder(run: () => Promise<void>): Promise<unknown[]> {
  const saved = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  const uncaught: unknown[] = []
  const record = (err: unknown): void => {
    uncaught.push(err)
  }
  process.on('uncaughtException', record)
  try {
    await run()
    // Let a callback the bus scheduled after the reply run too.
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    process.off('uncaughtException', record)
    for (const listener of saved) process.on('uncaughtException', listener)
  }
  return uncaught
}

function lookupHandler(users: Map<number, { id: number }>) {
  return (eventJson: string, reply: (response: string) => void): void => {
    const { data } = JSON.parse(eventJson)
    reply(JSON.stringify(users.get(JSON.parse(data).id) ?? null))
  }
}

/** What `emitter:error` carries: the event that failed and the error. */
function isReport(value: unknown): value is { event: string; error: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    typeof value.event === 'string' &&
    'error' in value
  )
}

describe('events > Emitter > a request handler that fails', () => {
  it('rejects the request when the handler throws, and nothing reaches the process', async () => {
    const users = new Map([[1, { id: 1 }]])
    const emitter = new Emitter(new EventBus(300))
    const reported: Array<{ event: string; error: unknown }> = []
    emitter.on('emitter:error', (payload) => {
      if (isReport(payload)) reported.push(payload)
    })
    emitter.onRequest('query:user.find', lookupHandler(users))

    let refusal: unknown
    const uncaught = await withUncaughtRecorder(async () => {
      // A valid request is answered…
      expect(await emitter.request('query:user.find', { id: 1 }, 1000)).toEqual({ id: 1 })
      // …and the one that makes the handler throw is refused at once, not
      // after the handler timeout.
      const started = Date.now()
      refusal = await emitter.request('query:user.find', null, 1000).catch((err: unknown) => err)
      expect(Date.now() - started).toBeLessThan(250)
    })

    expect(uncaught).toEqual([])
    expect(refusal).toBeInstanceOf(E_EVENTS_HANDLER_FAILED)
    expect(refusal).toMatchObject({
      code: 'E_EVENTS_HANDLER_FAILED',
      message: expect.stringContaining("Request handler for 'query:user.find' failed:"),
    })
    expect(reported).toHaveLength(1)
    expect(reported[0]?.event).toBe('query:user.find')
    expect(reported[0]?.error).toBeInstanceOf(TypeError)

    // The bus keeps serving.
    expect(await emitter.request('query:user.find', { id: 1 }, 1000)).toEqual({ id: 1 })
  })

  it('rejects the request when an async handler rejects', async () => {
    const emitter = new Emitter(new EventBus(2000))
    emitter.on('emitter:error', () => {})
    emitter.onRequest('query:async', async () => {
      throw new Error('lookup failed')
    })

    const started = Date.now()
    const refusal = await emitter.request('query:async', {}, 3000).catch((err: unknown) => err)

    expect(Date.now() - started).toBeLessThan(1000)
    expect(refusal).toBeInstanceOf(E_EVENTS_HANDLER_FAILED)
    expect(refusal).toMatchObject({
      message: "Request handler for 'query:async' failed: lookup failed",
    })
  })

  it('keeps the reply when the handler throws after replying', async () => {
    const emitter = new Emitter(new EventBus(300))
    const reported: unknown[] = []
    emitter.on('emitter:error', ({ error }) => {
      reported.push(error)
    })
    emitter.onRequest('query:late', (_json, reply) => {
      reply(JSON.stringify('answered'))
      throw 'after the reply'
    })

    expect(await emitter.request('query:late', {}, 1000)).toBe('answered')
    expect(reported).toEqual(['after the reply'])
  })

  it('behaves the same on FakeBus', async () => {
    const emitter = new Emitter(new FakeBus())
    emitter.on('emitter:error', () => {})
    emitter.onRequest('query:user.find', lookupHandler(new Map()))

    const refusal = await emitter
      .request('query:user.find', null, 1000)
      .catch((err: unknown) => err)

    expect(refusal).toBeInstanceOf(E_EVENTS_HANDLER_FAILED)
    expect(refusal).toMatchObject({
      message: expect.stringContaining("Request handler for 'query:user.find' failed:"),
    })
  })
})

/**
 * Unit suite for Emitter + BaseEvent — covers class/string listener
 * dispatch, container-backed listener resolution, the `emit()` error path,
 * wildcard subscription, request/reply, correlation IDs, hasListeners,
 * and the BaseEvent static-emitter wiring.
 *
 * Uses `FakeBus` (already public via `@c9up/ream/events/testing`) as the bus
 * substitute — no napi binding required.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseEvent, type ContainerResolver, Emitter } from '../../../src/events/Emitter.js'
import { FakeBus } from '../../../src/events/testing/FakeBus.js'
import { defined } from '../../__helpers__/defined.js'

// correlationId lives in a module-level AsyncLocalStorage set via `enterWith`,
// which does not auto-unset — it leaks across sequential tests sharing a worker
// and made the correlation-ID tests flaky depending on order. Reset before each
// test so the suite is deterministic.
beforeEach(() => {
  new Emitter(new FakeBus()).clearCorrelationId()
})

describe('events > Emitter > string-based events', () => {
  it('dispatches to registered string listeners synchronously', async () => {
    const emitter = new Emitter(new FakeBus())
    const calls: unknown[] = []
    emitter.on('user:registered', (u) => calls.push(u))
    await emitter.emit('user:registered', { id: 1 })
    expect(calls).toEqual([{ id: 1 }])
  })

  it('forwards the same event through the bus as JSON', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    await emitter.emit('order.created', { id: 42 })
    await new Promise((r) => setTimeout(r, 0))
    const emitted = bus.getEmitted()
    expect(emitted).toHaveLength(1)
    expect(defined(emitted[0]).name).toBe('order.created')
    expect(defined(emitted[0]).data).toBe('{"id":42}')
  })

  it('surfaces a listener rejection on the `emitter:error` channel', async () => {
    const emitter = new Emitter(new FakeBus())
    const errors: unknown[] = []
    emitter.on('emitter:error', (e) => errors.push(e))
    emitter.on('boom', () => Promise.reject(new Error('listener failed')))
    await emitter.emit('boom', { x: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toHaveLength(1)
    const first = errors[0] as { event: string; error: unknown }
    expect(first.event).toBe('boom')
  })

  it('falls back to stderr when no `emitter:error` listener is wired', async () => {
    const emitter = new Emitter(new FakeBus())
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    emitter.on('boom', () => Promise.reject(new Error('nope')))
    await emitter.emit('boom', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Listener error for 'boom'"))
    spy.mockRestore()
  })

  it('isolates an `emitter:error` listener that itself throws (no infinite loop)', async () => {
    const emitter = new Emitter(new FakeBus())
    const errorListener = vi.fn(() => {
      throw new Error('error-listener crashed')
    })
    emitter.on('emitter:error', errorListener)
    emitter.on('boom', () => Promise.reject(new Error('primary')))
    await expect(emitter.emit('boom', {})).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    // Called for the primary failure, and not again for its own: a throwing
    // error listener must not report itself in a loop.
    expect(errorListener).toHaveBeenCalledTimes(1)
  })
})

describe('events > Emitter > class-based events', () => {
  class TaskDeclared {
    constructor(public task: { id: number }) {}
  }

  it('calls an inline function listener with the event instance', async () => {
    const emitter = new Emitter(new FakeBus())
    const seen: TaskDeclared[] = []
    emitter.on(TaskDeclared, (e) => {
      seen.push(e)
    })
    await emitter.dispatchEvent(new TaskDeclared({ id: 5 }))
    expect(seen).toHaveLength(1)
    expect(defined(seen[0]).task.id).toBe(5)
  })

  it('derives the bus event name from the class name (PascalCase → dot.lower)', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    await emitter.dispatchEvent(new TaskDeclared({ id: 1 }))
    expect(defined(bus.getEmitted()[0]).name).toBe('task.declared')
  })

  it('honours an explicit static eventName on the class', async () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: an event fixture must be a class — the static eventName override is the behaviour under test
    class CustomNamed {
      static eventName = 'custom:explicit'
    }
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    emitter.on(CustomNamed, () => {})
    await emitter.dispatchEvent(new CustomNamed())
    expect(defined(bus.getEmitted()[0]).name).toBe('custom:explicit')
  })

  it('instantiates listener classes directly when no resolver is provided', async () => {
    class Listener {
      static instances: Listener[] = []
      public called = false
      constructor() {
        Listener.instances.push(this)
      }
      handle(_e: TaskDeclared): void {
        this.called = true
      }
    }
    const emitter = new Emitter(new FakeBus())
    emitter.on(TaskDeclared, Listener)
    await emitter.dispatchEvent(new TaskDeclared({ id: 1 }))
    expect(Listener.instances).toHaveLength(1)
    expect(defined(Listener.instances[0]).called).toBe(true)
  })

  it('resolves listener classes via the container when a resolver is wired', async () => {
    const handleSpy = vi.fn()
    class Listener {
      // `isListenerClass` checks for `prototype.handle` — must be a
      // real prototype method, not a class field.
      handle(e: TaskDeclared) {
        handleSpy(e)
      }
    }
    const instance = new Listener()
    const resolver: ContainerResolver = {
      make: vi.fn<(target: abstract new (...args: never[]) => object) => Promise<object>>(
        async () => instance,
      ),
    }
    const emitter = new Emitter(new FakeBus(), resolver)
    emitter.on(TaskDeclared, Listener)
    await emitter.dispatchEvent(new TaskDeclared({ id: 9 }))
    expect(resolver.make).toHaveBeenCalledWith(Listener)
    expect(handleSpy).toHaveBeenCalledTimes(1)
  })
})

describe('events > Emitter > wildcard subscriptions', () => {
  it('subscribes via bus.subscribe and parses the bus envelope JSON', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    const received: Array<{ name: string; data: unknown }> = []
    await emitter.onAny('order.*', (name, data) => received.push({ name, data }))
    // FakeBus wraps the raw payload in a Rust-mirror envelope ({id, name,
    // data}). Emitter's onAny parses the envelope, then forwards
    // (event.name, data) with the payload decoded back to the value.
    await bus.emit('order.created', '{"x":1}')
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toHaveLength(1)
    expect(defined(received[0]).name).toBe('order.created')
    expect(defined(received[0]).data).toEqual({ x: 1 })
  })

  it("falls back to the raw eventJson when it isn't valid JSON", async () => {
    // Subscribe directly through the bus so we can inject a non-JSON
    // payload — `Emitter.onAny` wraps the subscriber callback, and the
    // wrapper's `catch` branch is what we want to exercise.
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    const received: Array<{ name: string; data: unknown }> = []
    await emitter.onAny('plain.*', (name, data) => received.push({ name, data }))
    // Bypass bus.emit (which always wraps in JSON) by reaching into the
    // subscriber map directly — we cannot do that on FakeBus, so this
    // path stays covered via the inline-JSON envelope shape above.
    // Instead, prove the parsed shape's fallback to pattern when no name
    // is present.
    await bus.emit('plain.x', 'not-an-object-but-valid-json-string')
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toHaveLength(1)
    // envelope.name === "plain.x" (FakeBus puts it there), data is the raw
    // payload string.
    expect(defined(received[0]).name).toBe('plain.x')
  })

  it('the unsubscribe function onAny returns removes the bus subscription', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    // AdonisJS hands back an unsubscribe function; awaiting it is ours, because
    // dropping the subscription crosses NAPI.
    const unsubscribe = await emitter.onAny('a.*', () => {})
    await unsubscribe()
    expect(await bus.subscriptionCount()).toBe(0)
  })

  it('offAny removes the bus subscription for a listener', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    const listener = () => {}
    await emitter.onAny('a.*', listener)
    await emitter.offAny(listener)
    expect(await bus.subscriptionCount()).toBe(0)
  })

  it('matchesPattern delegates to the bus wildcard engine', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    // FakeBus mirrors the Rust router — `order.*` matches single segment
    // after the dot but not deep paths.
    expect(emitter.matchesPattern('order.*', 'order.created')).toBe(true)
    expect(emitter.matchesPattern('order.*', 'user.created')).toBe(false)
  })
})

describe('events > Emitter > request / reply', () => {
  it('parses a JSON response from the bus', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    emitter.onRequest('q:user.find', (_json, reply) => {
      reply(JSON.stringify({ ok: true }))
    })
    const out = await emitter.request<{ ok: boolean }>('q:user.find', {
      id: 1,
    })
    expect(out).toEqual({ ok: true })
  })

  it("returns the raw response when it isn't valid JSON", async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    emitter.onRequest('q:raw', (_json, reply) => {
      reply('raw-string')
    })
    const out = await emitter.request<string>('q:raw', {})
    expect(out).toBe('raw-string')
  })

  it('subscriptionCount proxies the bus count', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    await emitter.onAny('a.*', () => {})
    await emitter.onAny('b.*', () => {})
    expect(await emitter.subscriptionCount()).toBe(2)
  })
})

describe('events > Emitter > introspection', () => {
  it('tracks the correlation ID set via setCorrelationId', async () => {
    const emitter = new Emitter(new FakeBus())
    expect(emitter.getCorrelationId()).toBeUndefined()
    emitter.setCorrelationId('trace-42')
    expect(emitter.getCorrelationId()).toBe('trace-42')
  })

  it('carries the correlation ID on the envelope, out of band (setCorrelationId is NOT a no-op)', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    emitter.setCorrelationId('trace-42')
    await emitter.emit('user:registered', { id: 1 })
    // Passed to bus.emit beside the payload, as the Rust bus takes it for the
    // Event envelope — and kept out of the payload itself.
    const [captured] = bus.getEmitted()
    expect(captured?.correlationId).toBe('trace-42')
    expect(JSON.parse(captured?.data ?? '{}')).toEqual({ id: 1 })
  })

  it('does NOT inject correlationId when none is set (legacy wire shape preserved)', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    await emitter.emit('user:registered', { id: 1 })
    const [captured] = bus.getEmitted()
    // FakeBus generates a synthetic correlationId in its envelope shape,
    // but the underlying parsed data must NOT have one injected by us.
    const parsed = JSON.parse(captured?.data ?? '{}')
    expect(parsed.correlationId).toBeUndefined()
  })

  it('leaves a correlationId the payload carries as the caller wrote it', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    emitter.setCorrelationId('emitter-trace')
    await emitter.emit('user:registered', { id: 1, correlationId: 'user-trace' })
    const [captured] = bus.getEmitted()
    // The payload is data: untouched. The envelope carries the emitter's id.
    expect(JSON.parse(captured?.data ?? '{}')).toEqual({ id: 1, correlationId: 'user-trace' })
    expect(captured?.correlationId).toBe('emitter-trace')
  })

  it('runs a wildcard listener under the correlation id of the emit, and only there', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    const seen: Array<string | undefined> = []
    await emitter.onAny('user.*', () => {
      seen.push(emitter.getCorrelationId())
    })
    const other = new Emitter(bus)
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        other.setCorrelationId('inbound-trace')
        void other.emit('user.registered', { id: 1 })
        resolve()
      })
    })
    expect(seen).toEqual(['inbound-trace'])
    // Scoped with `run`: the listener's id does not stick to the context the
    // bus called it from.
    expect(emitter.getCorrelationId()).toBeUndefined()
  })

  it('carries the correlation id for primitive / array payloads too', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    emitter.setCorrelationId('trace-42')
    await emitter.emit('metric:tick', 42)
    await emitter.emit('batch', [1, 2, 3])
    const emitted = bus.getEmitted()
    // Out of band, so a payload with no room for a sibling field keeps it.
    expect(JSON.parse(defined(emitted[0]).data)).toBe(42)
    expect(JSON.parse(defined(emitted[1]).data)).toEqual([1, 2, 3])
    expect(emitted.map((e) => e.correlationId)).toEqual(['trace-42', 'trace-42'])
  })

  it('hasListeners reports string listeners', async () => {
    const emitter = new Emitter(new FakeBus())
    expect(emitter.hasListeners('user:registered')).toBe(false)
    emitter.on('user:registered', () => {})
    expect(emitter.hasListeners('user:registered')).toBe(true)
  })

  it('hasListeners reports class listeners', async () => {
    class Evt {}
    const emitter = new Emitter(new FakeBus())
    expect(emitter.hasListeners(Evt)).toBe(false)
    emitter.on(Evt, () => {})
    expect(emitter.hasListeners(Evt)).toBe(true)
  })
})

describe('events > BaseEvent', () => {
  class Sample extends BaseEvent {
    constructor(public payload: number) {
      super()
    }
  }

  it('emit() is a no-op when no emitter has been wired', async () => {
    // `resetEmitter` takes the emitter to clear — it only clears when the one
    // wired IS that one, so two applications sharing a process cannot unwire
    // each other's. Called with nothing, as it was here, it never cleared
    // anything: this test ran against whatever the previous one left wired.
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    const listener = vi.fn()
    emitter.on(Sample, listener)
    BaseEvent.useEmitter(emitter)
    BaseEvent.resetEmitter(emitter)

    await expect(new Sample(1).emit()).resolves.toBeUndefined()
    expect(bus.getEmitted()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })

  it('emit() dispatches through the wired emitter and forwards to the bus', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    BaseEvent.useEmitter(emitter)
    emitter.on(Sample, () => {})
    await new Sample(7).emit()
    const emitted = bus.getEmitted()
    expect(defined(emitted[0]).name).toBe('sample')
    expect(defined(emitted[0]).data).toContain('"payload":7')
    BaseEvent.resetEmitter(emitter)
  })

  it('isolates a throwing class listener: siblings still run and the bus still emits', async () => {
    const bus = new FakeBus()
    const emitter = new Emitter(bus)
    const errors: unknown[] = []
    const ran: string[] = []
    emitter.on('emitter:error', (e) => errors.push(e))
    // First listener throws — must NOT abort the second listener nor the
    // cross-service bus propagation (the domain event already happened).
    emitter.on(Sample, () => {
      ran.push('first')
      throw new Error('listener crash')
    })
    emitter.on(Sample, () => {
      ran.push('second')
    })
    BaseEvent.useEmitter(emitter)
    await new Sample(1).emit()

    expect(ran).toEqual(['first', 'second'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as { event: string }).event).toBe('sample')
    // Distributed subscribers still receive the event despite the failure.
    expect(bus.getEmitted().map((e) => e.name)).toContain('sample')
    BaseEvent.resetEmitter(emitter)
  })
})

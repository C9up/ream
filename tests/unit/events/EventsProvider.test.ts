/**
 * EventsProvider — host-container compatibility.
 *
 * Pre-fix `EventsProvider` passed `app.container` (which only declares
 * `singleton + resolve`) directly into `new Emitter(bus, container)`,
 * but Emitter's `ContainerResolver` requires `make()`. TS didn't catch
 * the mismatch because the bus package had no `typecheck` script, so the
 * runtime call to `this.resolver.make(...)` would have crashed the
 * first time a CLASS listener fired.
 *
 * Post-fix: EventsProvider only forwards a resolver when the container
 * actually exposes `make`. Listener CLASSES still work via the
 * `new Listener()` fallback in Emitter when no resolver is available.
 */
import { describe, expect, it } from 'vitest'
import { Emitter } from '../../../src/events/Emitter.js'
import EventsProvider from '../../../src/events/EventsProvider.js'
import { EventBus } from '../../../src/events/native.js'

class TaskAssigned {
  constructor(public taskId: string) {}
}

class FakeListener {
  public received: TaskAssigned[] = []
  async handle(event: TaskAssigned): Promise<void> {
    this.received.push(event)
  }
}

function buildContainerWithoutMake() {
  const bindings = new Map<unknown, () => unknown>()
  const cache = new Map<unknown, unknown>()
  const container = {
    singleton(token: unknown, factory: () => unknown): void {
      bindings.set(token, factory)
    },
    // Async + awaits the factory, mirroring the real IoC container so factories
    // that return a Promise (e.g. EventsProvider's Emitter factory) resolve to
    // the value, not the Promise.
    async resolve<T = unknown>(token: unknown): Promise<T> {
      if (cache.has(token)) return cache.get(token) as T
      const factory = bindings.get(token)
      if (!factory) throw new Error(`not registered: ${String(token)}`)
      const value = await factory()
      cache.set(token, value)
      return value as T
    },
  }
  return container
}

function buildContainerWithMake() {
  const base = buildContainerWithoutMake()
  const calls: Array<new (...args: never[]) => unknown> = []
  return {
    ...base,
    async make<T>(Target: new (...args: never[]) => T): Promise<T> {
      calls.push(Target)
      return new Target()
    },
    makeCalls: calls,
  }
}

describe('EventsProvider > container compatibility', () => {
  it('registers Emitter even when the host container has no make() (no-op resolver path)', async () => {
    const container = buildContainerWithoutMake()
    const provider = new EventsProvider({ container })
    provider.register()
    await provider.boot()

    // Emitter is bound and usable.
    const emitter = await container.resolve<Emitter>(Emitter)
    expect(emitter).toBeInstanceOf(Emitter)

    // CLASS listeners still fire via the `new Listener()` fallback —
    // proves the provider doesn't crash trying to invoke make().
    emitter.on(TaskAssigned, FakeListener)
    await emitter.dispatchEvent(new TaskAssigned('t-1'))
    // (No assertion on the instance state — the fallback creates a
    // fresh instance per call; we just verify no crash occurred.)
  })

  it('forwards a make-based resolver when the host container exposes one', async () => {
    const container = buildContainerWithMake()
    const provider = new EventsProvider({ container })
    provider.register()
    await provider.boot()

    const emitter = await container.resolve<Emitter>(Emitter)
    emitter.on(TaskAssigned, FakeListener)
    await emitter.dispatchEvent(new TaskAssigned('t-2'))

    expect(container.makeCalls).toContain(FakeListener)
  })

  it("EventBus is bound under its class token AND the 'bus' alias", async () => {
    const container = buildContainerWithoutMake()
    const provider = new EventsProvider({ container })
    provider.register()
    await provider.boot()

    const viaClass = await container.resolve<EventBus>(EventBus)
    const viaAlias = await container.resolve<EventBus>('bus')
    expect(viaClass).toBeInstanceOf(EventBus)
    expect(viaAlias).toBe(viaClass)
  })
})

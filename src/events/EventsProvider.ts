import { BaseEvent, Emitter } from './Emitter.js'
import { EventBus } from './native.js'
import { setEmitter } from './services/main.js'

/**
 * Host context for the events provider. The container is referenced
 * structurally (not via a concrete import) so the provider stays a thin
 * seam over ream's IoC container.
 *
 * `make()` is the listener-class resolver Emitter needs. When the host
 * doesn't expose it, listener CLASSES can't be instantiated — only inline
 * function listeners work. The optional `make` field mirrors Emitter's
 * `ContainerResolver` interface so the assignment type-checks without a
 * load-bearing cast.
 */
interface EventsContainer {
  singleton(token: unknown, factory: () => unknown): void
  resolve<T = unknown>(token: unknown): T
  make?<T>(target: new (...args: never[]) => T): T
}
export interface EventsAppContext {
  container: EventsContainer
}

export default class EventsProvider {
  constructor(protected app: EventsAppContext) {}

  register() {
    this.app.container.singleton(EventBus, () => new EventBus())
    this.app.container.singleton('bus', () => this.app.container.resolve<EventBus>(EventBus))

    this.app.container.singleton(Emitter, () => {
      const bus = this.app.container.resolve<EventBus>(EventBus)
      // Forward `make` only when the host actually exposes it.
      // Emitter falls back to direct `new Listener()` instantiation
      // otherwise, which keeps zero-arg listener classes working
      // without a full IoC container.
      const resolver =
        typeof this.app.container.make === 'function'
          ? { make: this.app.container.make.bind(this.app.container) }
          : undefined
      return new Emitter(bus, resolver)
    })
    this.app.container.singleton('emitter', () => this.app.container.resolve<Emitter>(Emitter))
    // Primary public token — `ctx.events` and `container.resolve('events')`.
    this.app.container.singleton('events', () => this.app.container.resolve<Emitter>(Emitter))
  }

  async boot() {
    const emitter = this.app.container.resolve<Emitter>(Emitter)
    BaseEvent.useEmitter(emitter)
    setEmitter(emitter)
  }

  async shutdown() {
    BaseEvent.resetEmitter()
  }
}

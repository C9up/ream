/**
 * Emitter — AdonisJS-compatible typed event system backed by EventBus.
 *
 * Class-based events:
 *   emitter.on(TaskDeclared, SendNotification)
 *   await new TaskDeclared(task).emit()
 *
 * String-based events:
 *   emitter.on('user:registered', (user) => { ... })
 *   emitter.emit('user:registered', user)
 *
 * Listeners support @inject() for DI when a container resolver is provided.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { EventBus } from './native.js'

/** Per-request correlation ID stored in async context so concurrent requests don't corrupt each other. */
const correlationStorage = new AsyncLocalStorage<string | undefined>()

/**
 * Listener class interface — must have a handle() method.
 */
export interface ListenerClass<T = unknown> {
  handle(event: T): Promise<void> | void
}

type EventConstructor<T = unknown> = new (...args: never[]) => T

type ListenerFn<T = unknown> = (event: T) => Promise<void> | void

type ListenerConstructor<T = unknown> = new (...args: never[]) => ListenerClass<T>

type Listener<T = unknown> = ListenerFn<T> | ListenerConstructor<T>

/** Resolver for instantiating listener classes with DI. */
export interface ContainerResolver {
  make<T>(target: new (...args: never[]) => T): T
}

export class Emitter {
  private bus: EventBus
  private resolver?: ContainerResolver
  private classListeners: Map<EventConstructor, Listener[]> = new Map()
  private stringListeners: Map<string, ListenerFn[]> = new Map()

  constructor(bus: EventBus, resolver?: ContainerResolver) {
    this.bus = bus
    this.resolver = resolver
  }

  // ─── Class-based events ───────────────────────────────────

  /**
   * Listen for a class-based event.
   *   emitter.on(TaskDeclared, SendNotification)        // listener class
   *   emitter.on(TaskDeclared, (event) => { ... })       // inline function
   */
  on<T>(event: EventConstructor<T>, listener: Listener<T>): void
  /**
   * Listen for a string-based event.
   *   emitter.on('user:registered', (user) => { ... })
   *   emitter.on<User>('user:registered', (user) => { ... })  // typed payload
   */
  on<T>(event: string, listener: ListenerFn<T>): void
  on(event: EventConstructor | string, listener: Listener): void {
    if (typeof event === 'string') {
      const list = this.stringListeners.get(event) ?? []
      list.push(listener as ListenerFn)
      this.stringListeners.set(event, list)
    } else {
      const list = this.classListeners.get(event) ?? []
      list.push(listener)
      this.classListeners.set(event, list)
    }
  }

  // ─── Emit ─────────────────────────────────────────────────

  /**
   * Emit a string-based event.
   */
  emit(event: string, data: unknown): void {
    // Dispatch to string listeners
    const listeners = this.stringListeners.get(event)
    if (listeners) {
      for (const fn of listeners) {
        Promise.resolve(fn(data)).catch((err) => {
          // Surface listener errors instead of swallowing them
          this.emitError(event, err)
        })
      }
    }

    // Also push through EventBus for cross-service / Rust subscribers.
    // `#wrapForBus` prepends the correlation envelope when set so the ID
    // reaches the other side; without it `setCorrelationId()` was a no-op.
    void this.bus.emit(event, JSON.stringify(this.#wrapForBus(data))).catch((err: unknown) => {
      this.emitError(event, err)
    })
  }

  /** Emit an error event for listener failures. */
  private emitError(event: string, error: unknown): void {
    const errorListeners = this.stringListeners.get('emitter:error')
    if (errorListeners && errorListeners.length > 0) {
      for (const fn of errorListeners) {
        try {
          fn({ event, error })
        } catch {
          /* prevent infinite loop */
        }
      }
    } else {
      // No error listener — log to stderr as last resort
      process.stderr.write(`[events] Listener error for '${event}': ${error}\n`)
    }
  }

  /**
   * Dispatch a class-based event. Called by BaseEvent#emit().
   */
  async dispatchEvent<T extends object>(event: T): Promise<void> {
    const EventClass = event.constructor as EventConstructor<T>
    const listeners = this.classListeners.get(EventClass) ?? []
    const name = (EventClass as { eventName?: string }).eventName ?? classToEventName(EventClass)

    // Per-listener error isolation — mirrors the string `emit()` contract.
    // A side-effect listener that throws (SMTP down, etc.) MUST NOT abort
    // the sibling listeners NOR suppress the cross-service `bus.emit` below:
    // the domain event already happened, so distributed subscribers must
    // still receive it. Failures surface on the `emitter:error` channel.
    for (const listener of listeners) {
      try {
        if (isListenerClass(listener)) {
          // Listener class — resolve via container for @inject() support
          const instance = this.resolver
            ? this.resolver.make(listener as ListenerConstructor<T>)
            : new (listener as ListenerConstructor<T>)()
          await instance.handle(event)
        } else {
          await (listener as ListenerFn<T>)(event)
        }
      } catch (err) {
        this.emitError(name, err)
      }
    }

    // Also push through EventBus — same correlation-envelope wrapping as
    // the string-event path so distributed tracing covers class events too.
    // Reached unconditionally: a listener failure above no longer skips it.
    await this.bus.emit(name, JSON.stringify(this.#wrapForBus(event)))
  }

  // ─── Wildcard subscriptions (via Rust NAPI) ───────────────

  /**
   * Subscribe to events matching a wildcard pattern.
   * Uses Rust wildcard engine via NAPI for pattern matching.
   *
   *   emitter.onAny('order.*', (name, data) => { ... })   // single segment
   *   emitter.onAny('order.**', (name, data) => { ... })  // deep match
   */
  async onAny(
    pattern: string,
    listener: (eventName: string, data: unknown) => void,
  ): Promise<number> {
    return this.bus.subscribe(pattern, (eventJson: string) => {
      try {
        const event = JSON.parse(eventJson)
        // The bus delivers a Rust `Event` envelope whose `correlationId`
        // sits at the top of the parsed JSON. Propagate it onto the
        // emitter so nested emits inside the listener body inherit the
        // trace context — that's the whole point of the API. `data` is
        // the raw user payload string (still JSON-encoded if the
        // emitter serialized an object), kept as-is for back-compat.
        if (
          event !== null &&
          typeof event === 'object' &&
          typeof event.correlationId === 'string'
        ) {
          this.setCorrelationId(event.correlationId)
        }
        listener(event.name ?? pattern, event.data ?? event)
      } catch {
        listener(pattern, eventJson)
      }
    })
  }

  /** Unsubscribe a wildcard subscription by ID. */
  async offAny(subscriptionId: number): Promise<void> {
    await this.bus.unsubscribe(subscriptionId)
  }

  /** Check if a pattern matches an event name (wildcard matching via Rust). */
  matchesPattern(pattern: string, eventName: string): boolean {
    return this.bus.matchesWildcard(pattern, eventName)
  }

  // ─── Request / Reply ──────────────────────────────────────

  /**
   * Send a request event and await a response.
   *
   *   const user = await emitter.request('query:user.find', { id: 1 })
   */
  async request<T = unknown>(name: string, data: unknown, timeoutMs = 5000): Promise<T> {
    // Same correlation injection as `emit()` so a `setCorrelationId`
    // preceding a request actually reaches the responder via the
    // top-level `correlationId` field on the parsed payload.
    const result = await this.bus.request(name, JSON.stringify(this.#wrapForBus(data)), timeoutMs)
    try {
      return JSON.parse(result) as T
    } catch {
      return result as T
    }
  }

  /**
   * Register a request handler.
   *
   *   emitter.onRequest('query:user.find', (params, reply) => {
   *     const user = db.find(params.id)
   *     reply(JSON.stringify(user))
   *   })
   */
  onRequest(
    name: string,
    handler: (eventJson: string, reply: (response: string) => void) => void,
  ): void {
    this.bus.onRequest(name, handler)
  }

  // ─── Correlation context ──────────────────────────────────

  /**
   * Set the correlation ID for subsequent events in the current async context.
   * Uses AsyncLocalStorage so concurrent requests each have their own trace ID —
   * a shared mutable field would let concurrent requests corrupt each other.
   */
  setCorrelationId(id: string): void {
    correlationStorage.enterWith(id)
  }

  /**
   * Clear the correlation ID for the current async context. `enterWith` does
   * not auto-unset, so a long-lived/reused context (and, notably, sequential
   * tests sharing a worker) would leak the last set id — call this to reset.
   */
  clearCorrelationId(): void {
    correlationStorage.enterWith(undefined)
  }

  /** Get the correlation ID for the current async context. */
  getCorrelationId(): string | undefined {
    return correlationStorage.getStore()
  }

  /** Inject the active correlation ID at the top level of the payload. */
  #wrapForBus(data: unknown): unknown {
    const correlationId = correlationStorage.getStore()
    if (correlationId === undefined) return data
    if (!isPlainObject(data)) return data
    if (typeof data.correlationId === 'string') return data
    return { ...data, correlationId }
  }

  // ─── Introspection ────────────────────────────────────────

  /**
   * Check if any listeners are registered for an event.
   */
  hasListeners(event: EventConstructor | string): boolean {
    if (typeof event === 'string') {
      return (this.stringListeners.get(event)?.length ?? 0) > 0
    }
    return (this.classListeners.get(event)?.length ?? 0) > 0
  }

  /** Get the number of Rust-side subscriptions. */
  async subscriptionCount(): Promise<number> {
    return this.bus.subscriptionCount()
  }
}

/**
 * BaseEvent — extend to create typed event classes.
 *
 * Usage:
 *   class TaskDeclared extends BaseEvent {
 *     constructor(public task: Task) { super() }
 *   }
 *
 *   // In controller:
 *   await new TaskDeclared(task).emit()
 *
 *   // In events.ts:
 *   emitter.on(TaskDeclared, LogTaskEvent)
 */
export class BaseEvent {
  static eventName?: string
  private static _emitter: Emitter | undefined

  /** @internal Wire the emitter (called by EventsProvider). */
  static useEmitter(emitter: Emitter): void {
    BaseEvent._emitter = emitter
  }

  /** @internal Ownership-guarded reset — only clears if `emitter` is still the active one. */
  static resetEmitter(emitter: Emitter): void {
    if (BaseEvent._emitter === emitter) BaseEvent._emitter = undefined
  }

  /**
   * Dispatch this event instance via the wired emitter.
   * No-op if no emitter is wired (test/standalone mode).
   */
  async emit(): Promise<void> {
    if (!BaseEvent._emitter) return
    try {
      await BaseEvent._emitter.dispatchEvent(this)
    } catch (err) {
      process.stderr.write(`[events] dispatch error for ${this.constructor.name}: ${err}\n`)
    }
  }
}

/** Convert PascalCase class name to dot.separated event name. */
function classToEventName(cls: EventConstructor): string {
  return cls.name.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase()
}

/** Check if a listener entry is a class (has prototype.handle) vs a function. */
function isListenerClass(listener: Listener): boolean {
  return typeof listener === 'function' && typeof listener.prototype?.handle === 'function'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

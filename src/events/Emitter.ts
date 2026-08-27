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
import { type BufferedEventName, EventsBuffer } from './EventsBuffer.js'
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

/**
 * Resolver for instantiating listener classes with DI — the narrow shape the
 * emitter needs, so a test can hand it a fake without building a container.
 * The real {@link import('../container/ContainerResolver.js').ContainerResolver}
 * satisfies it.
 */
export interface EmitterResolver {
  make<T>(target: new (...args: never[]) => T): Promise<T>
}

/**
 * @deprecated Use {@link EmitterResolver}. The name now belongs to the real
 * per-request resolver exported from `@c9up/ream`, as in AdonisJS.
 */
export type ContainerResolver = EmitterResolver

/**
 * What `on` / `once` / `onAny` hand back: call it to stop listening. Named
 * after the AdonisJS type of the same shape.
 */
export type UnsubscribeFunction = () => void

/**
 * What `onAny` hands back. Same shape as {@link UnsubscribeFunction} — and
 * assignable wherever one is expected — but awaitable, because dropping a
 * wildcard subscription is a NAPI call into the Rust bus. Ignore the promise
 * for the AdonisJS behaviour; await it when the next assertion depends on the
 * subscription being gone.
 */
export type AsyncUnsubscribeFunction = () => Promise<void>

export class Emitter {
  private bus: EventBus
  private resolver?: EmitterResolver
  private classListeners: Map<EventConstructor, Listener[]> = new Map()
  private stringListeners: Map<string, ListenerFn[]> = new Map()
  /** Set while faking; every emission lands here instead of running. */
  #buffer?: EventsBuffer
  /** Which events are faked. `undefined` means all of them. */
  #fakedEvents?: Set<BufferedEventName>
  /** Wildcard subscriptions, so `offAny(listener)` can find its Rust handle. */
  readonly #anySubscriptions = new Map<(eventName: string, data: unknown) => void, Set<number>>()

  constructor(bus: EventBus, resolver?: EmitterResolver) {
    this.bus = bus
    this.resolver = resolver
  }

  // ─── Class-based events ───────────────────────────────────

  /**
   * Listen for a class-based event.
   *   emitter.on(TaskDeclared, SendNotification)        // listener class
   *   emitter.on(TaskDeclared, (event) => { ... })       // inline function
   */
  on<T>(event: EventConstructor<T>, listener: Listener<T>): UnsubscribeFunction
  /**
   * Listen for a string-based event.
   *   emitter.on('user:registered', (user) => { ... })
   *   emitter.on<User>('user:registered', (user) => { ... })  // typed payload
   *
   * Returns an unsubscribe function, as AdonisJS does — keeping the listener
   * reference around just to pass it back to `off` is the boilerplate that
   * function removes.
   */
  on<T>(event: string, listener: ListenerFn<T>): UnsubscribeFunction
  on(event: EventConstructor | string, listener: Listener): UnsubscribeFunction {
    if (typeof event === 'string') {
      const list = this.stringListeners.get(event) ?? []
      list.push(listener as ListenerFn)
      this.stringListeners.set(event, list)
      return () => {
        this.off(event, listener as ListenerFn)
      }
    }
    const list = this.classListeners.get(event) ?? []
    list.push(listener)
    this.classListeners.set(event, list)
    return () => {
      const current = this.classListeners.get(event)
      if (!current) return
      const index = current.indexOf(listener)
      if (index !== -1) current.splice(index, 1)
    }
  }

  /**
   * Listen for the NEXT occurrence only (AdonisJS `once`).
   *
   * The listener removes itself before running, so a handler that emits the
   * same event does not re-enter it.
   */
  once<T>(event: string, listener: ListenerFn<T>): void {
    const wrapper: ListenerFn = (data) => {
      this.off(event, wrapper)
      return (listener as ListenerFn)(data)
    }
    this.on(event, wrapper as ListenerFn<T>)
  }

  /**
   * Register the listener only when `condition` holds (AdonisJS `listenIf`) —
   * the shape a feature flag takes at boot, without an `if` around every call.
   */
  listenIf<T>(condition: boolean | (() => boolean), event: string, listener: ListenerFn<T>): void {
    // AdonisJS takes either — a thunk lets the flag be read at registration
    // time rather than at the call site.
    if (typeof condition === 'function' ? condition() : condition) this.on(event, listener)
  }

  /** Alias of {@link on} (AdonisJS names it `listen`). */
  listen<T>(event: string, listener: ListenerFn<T>): void {
    this.on(event, listener)
  }

  /** Report listener failures (AdonisJS `onError`). */
  onError(listener: (event: string, error: unknown) => void): void {
    this.on('emitter:error', (payload) => {
      const detail = payload as { event?: string; error?: unknown }
      listener(detail?.event ?? 'unknown', detail?.error)
    })
  }

  /** Remove one listener from an event (AdonisJS `off`). */
  off(event: string, listener: ListenerFn): void {
    const list = this.stringListeners.get(event)
    if (!list) return
    const index = list.indexOf(listener)
    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this.stringListeners.delete(event)
  }

  /** Alias of {@link off} (AdonisJS `clearListener`). */
  clearListener(event: string, listener: ListenerFn): void {
    this.off(event, listener)
  }

  /** Drop every listener of one event (AdonisJS `clearListeners`). */
  clearListeners(event: string): void {
    this.stringListeners.delete(event)
  }

  /** Drop every listener of every event (AdonisJS `clearAllListeners`). */
  clearAllListeners(): void {
    this.stringListeners.clear()
    this.classListeners.clear()
  }

  /**
   * Every event with the listeners registered for it (AdonisJS
   * `eventsListeners`).
   *
   * Read-only copies: a caller inspecting the map — a debug screen, a test
   * asserting nothing leaked — must not be able to unsubscribe by mutating it.
   */
  get eventsListeners(): Map<EventConstructor | string, Listener[]> {
    const all = new Map<EventConstructor | string, Listener[]>()
    for (const [event, listeners] of this.classListeners) all.set(event, [...listeners])
    for (const [event, listeners] of this.stringListeners) all.set(event, [...listeners])
    return all
  }

  /** How many listeners an event has, or all of them (AdonisJS `listenerCount`). */
  listenerCount(event?: string): number {
    if (event !== undefined) return this.stringListeners.get(event)?.length ?? 0
    let total = 0
    for (const list of this.stringListeners.values()) total += list.length
    for (const list of this.classListeners.values()) total += list.length
    return total
  }

  // ─── Emit ─────────────────────────────────────────────────

  /**
   * Run an event's listeners, in parallel or one after another.
   *
   * A listener that throws is reported and does NOT stop the others: one
   * failing subscriber must not silently cancel the rest of the reaction to an
   * event it does not own.
   */
  async #dispatchListeners(event: string, data: unknown, serial: boolean): Promise<void> {
    const listeners = [
      ...(this.stringListeners.get(event) ?? []),
      ...this.#wildcardListenersFor(event),
    ]
    if (listeners.length === 0) return
    const run = async (fn: ListenerFn): Promise<void> => {
      try {
        await fn(data)
      } catch (err) {
        this.emitError(event, err)
      }
    }
    if (serial) {
      for (const fn of listeners) await run(fn)
      return
    }
    await Promise.all(listeners.map(run))
  }

  /** Listeners registered through `onAny` whose pattern matches `event`. */
  #wildcardListenersFor(_event: string): ListenerFn[] {
    return []
  }

  /**
   * Emit and run the listeners ONE AT A TIME (AdonisJS `emitSerial`).
   *
   * Use it when order matters — a listener that seeds what the next one reads.
   */
  async emitSerial(event: string, data: unknown): Promise<void> {
    if (this.#capture(event, data)) return
    await this.#dispatchListeners(event, data, true)
    this.#publishToBus(event, data)
  }

  /**
   * Emit a string-based event.
   *
   * Returns a promise resolving once every listener has finished, as AdonisJS
   * does — awaiting it is how a handler makes sure the work it triggered
   * actually happened before it answers. Listeners run in PARALLEL; use
   * {@link emitSerial} when one has to finish before the next starts.
   *
   * Not awaiting it keeps the old fire-and-forget behaviour: a listener that
   * rejects is reported through `emitError`, never left unhandled.
   */
  async emit(event: string, data: unknown): Promise<void> {
    if (this.#capture(event, data)) return
    await this.#dispatchListeners(event, data, false)
    this.#publishToBus(event, data)
  }

  /**
   * Push the event onto the bus for cross-service / Rust subscribers.
   *
   * `#wrapForBus` prepends the correlation envelope when set so the ID reaches
   * the other side; without it `setCorrelationId()` was a no-op.
   */
  #publishToBus(event: string, data: unknown): void {
    // Serialize INSIDE the guard. `JSON.stringify` throws synchronously on a
    // cycle or a BigInt, and it was evaluated as an argument — so the throw
    // escaped past the `.catch` and crashed the caller.
    let payload: string
    try {
      payload = JSON.stringify(this.#wrapForBus(data))
    } catch (err) {
      this.emitError(event, err)
      return
    }
    void this.bus.emit(event, payload).catch((err: unknown) => {
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
    // Faked by the class, as AdonisJS does — `fake([TaskDeclared])` catches
    // `new TaskDeclared(...).emit()`.
    if (this.#capture(EventClass, event)) return
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
            ? await this.resolver.make(listener as ListenerConstructor<T>)
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

  // ─── Faking (AdonisJS `fake` / `restore`) ─────────────────

  /**
   * Stop the named events from reaching their listeners and the bus, and
   * collect them instead.
   *
   * With no argument every event is faked. Calling it again drops the previous
   * fake and starts a fresh buffer, as AdonisJS does.
   *
   * ```ts
   * const events = emitter.fake(['user:registered'])
   * await register(payload)
   * events.assertEmitted('user:registered')
   * emitter.restore()
   * ```
   */
  fake(events?: BufferedEventName[]): EventsBuffer {
    this.restore()
    this.#fakedEvents = events === undefined ? undefined : new Set(events)
    this.#buffer = new EventsBuffer(() => {
      this.restore()
    })
    return this.#buffer
  }

  /** Let events through again (AdonisJS `restore`). */
  restore(): void {
    this.#buffer = undefined
    this.#fakedEvents = undefined
  }

  /**
   * Record the emission and report whether it was swallowed.
   *
   * Returns `true` when the event is faked — the caller must then return
   * without dispatching or publishing, which is what "the listeners are not
   * invoked" means.
   */
  #capture(event: BufferedEventName, data: unknown): boolean {
    if (this.#buffer === undefined) return false
    if (this.#fakedEvents !== undefined && !this.#fakedEvents.has(event)) return false
    this.#buffer.add(event, data)
    return true
  }

  // ─── Wildcard subscriptions (via Rust NAPI) ───────────────

  /**
   * Subscribe to events matching a wildcard pattern.
   * Uses Rust wildcard engine via NAPI for pattern matching.
   *
   *   emitter.onAny('order.*', (name, data) => { ... })   // single segment
   *   emitter.onAny('order.**', (name, data) => { ... })  // deep match
   */
  async onAny(listener: (eventName: string, data: unknown) => void): Promise<UnsubscribeFunction>
  async onAny(
    pattern: string,
    listener: (eventName: string, data: unknown) => void,
  ): Promise<UnsubscribeFunction>
  async onAny(
    patternOrListener: string | ((eventName: string, data: unknown) => void),
    maybeListener?: (eventName: string, data: unknown) => void,
  ): Promise<UnsubscribeFunction> {
    // `onAny(listener)` — every event, the AdonisJS signature. `**` is the
    // deep-match pattern the Rust matcher already understands, so the two
    // forms share one implementation.
    const pattern = typeof patternOrListener === 'string' ? patternOrListener : '**'
    const listener = typeof patternOrListener === 'string' ? maybeListener : patternOrListener
    if (listener === undefined) {
      throw new TypeError('onAny() requires a listener')
    }
    const id = await this.#subscribeAny(pattern, listener)

    // AdonisJS hands back the unsubscribe function, not the handle. The Rust
    // subscription id stays reachable through `offAny(id)` because that is what
    // the bus needs, but a caller following the AdonisJS shape never sees it.
    let ids = this.#anySubscriptions.get(listener)
    if (!ids) {
      ids = new Set()
      this.#anySubscriptions.set(listener, ids)
    }
    ids.add(id)

    return async () => {
      await this.offAny(id)
    }
  }

  async #subscribeAny(
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

  /**
   * Stop a wildcard subscription (AdonisJS `offAny`).
   *
   * Takes the listener, as AdonisJS does. The numeric handle the Rust bus
   * issued is also accepted, because that is what the unsubscribe crosses NAPI
   * with and `onAny`'s unsubscribe function closes over it.
   *
   * Async where AdonisJS is sync: dropping the subscription is a NAPI call, and
   * returning before it lands would let an event through after `offAny`.
   */
  async offAny(listenerOrId: number | ((eventName: string, data: unknown) => void)): Promise<this> {
    if (typeof listenerOrId === 'number') {
      await this.bus.unsubscribe(listenerOrId)
      for (const ids of this.#anySubscriptions.values()) ids.delete(listenerOrId)
      return this
    }

    const ids = this.#anySubscriptions.get(listenerOrId)
    if (!ids) return this
    this.#anySubscriptions.delete(listenerOrId)
    await Promise.all([...ids].map((id) => this.bus.unsubscribe(id)))
    return this
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
  hasListeners(event?: EventConstructor | string): boolean {
    // AdonisJS makes the argument optional: no argument asks whether ANY event
    // has a listener at all.
    if (event === undefined) return this.listenerCount() > 0
    if (typeof event === 'string') return (this.stringListeners.get(event)?.length ?? 0) > 0
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
  /**
   * Subclasses declare their own payload parameters; this signature only has
   * to be wide enough for `dispatch` to forward them (AdonisJS does the same).
   * It widens `ConstructorParameters<typeof BaseEvent>` from `[]` to a rest
   * parameter, which is what lets `dispatch` call `new this(...args)`.
   */
  // biome-ignore lint/complexity/noUselessConstructor: it widens ConstructorParameters for dispatch — removing it fails to compile
  constructor(..._args: unknown[]) {}

  static eventName?: string

  /**
   * The emitter events dispatch through. Public, as in AdonisJS: a test swaps
   * it to capture dispatches without booting a provider.
   */
  static emitter: Emitter | undefined

  /** @internal Wire the emitter (called by EventsProvider). */
  static useEmitter(emitter: Emitter): void {
    BaseEvent.emitter = emitter
  }

  /** @internal Ownership-guarded reset — only clears if `emitter` is still the active one. */
  static resetEmitter(emitter: Emitter): void {
    if (BaseEvent.emitter === emitter) BaseEvent.emitter = undefined
  }

  /**
   * Construct and dispatch in one call — `OrderShipped.dispatch(order)`.
   *
   * The AdonisJS idiom, and the reason `emit()` alone is not enough: an event
   * is almost always built only to be emitted, and naming the class twice to
   * do it is what the static removes.
   */
  static async dispatch<T extends typeof BaseEvent>(
    this: T,
    ...args: ConstructorParameters<T>
  ): Promise<void> {
    await new this(...args).emit()
  }

  /**
   * Dispatch this event instance via the wired emitter.
   * No-op if no emitter is wired (test/standalone mode).
   */
  async emit(): Promise<void> {
    if (!BaseEvent.emitter) return
    try {
      await BaseEvent.emitter.dispatchEvent(this)
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

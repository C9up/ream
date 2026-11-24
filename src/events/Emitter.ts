/**
 * Emitter — AdonisJS-compatible typed event system backed by EventBus.
 *
 * Class-based events:
 *   emitter.on(TaskDeclared, [SendNotification])
 *   await new TaskDeclared(task).emit()
 *
 * String-based events:
 *   emitter.on('user:registered', (user) => { ... })
 *   emitter.emit('user:registered', user)
 *
 * Listeners take the AdonisJS forms on both kinds of event: a function, a
 * `[ListenerClass, 'method']` tuple, a `[() => import('#listeners/x'), 'method']`
 * lazy tuple (the module is imported on the first emit, not at boot), and — a
 * ream shorthand — a bare listener class standing for `[ListenerClass, 'handle']`.
 * Listener classes are built through the container resolver when one is given,
 * so they get `@inject()` dependencies.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  E_APP_MISSING_DEFAULT_EXPORT,
  E_EVENTS_INVALID_ARGUMENT,
  E_EVENTS_MISSING_LISTENER_METHOD,
} from '../errors/codes.js'
import { callNativeAsync, fromNativeError } from '../errors/native.js'
import { safeJsonParse } from '../utils/safeJsonParse.js'
import { type BufferedEventName, EventsBuffer } from './EventsBuffer.js'
import type { EventBus } from './native.js'

/** Per-request correlation ID stored in async context so concurrent requests don't corrupt each other. */
const correlationStorage = new AsyncLocalStorage<string | undefined>()

/**
 * Listener class interface — must have a handle() method.
 */
export interface ListenerClass<T = unknown> {
  handle(event: T): unknown
}

type EventConstructor<T = unknown> = new (...args: never[]) => T

/**
 * A listener. Whatever it returns is awaited and dropped.
 *
 * `unknown`, not `Promise<void> | void`: a bare `void` return type accepts a
 * function returning anything, but a UNION containing it does not — so
 * `emitter.on('x', (d) => received.push(d))` was a type error for returning
 * what `push` returns, which nothing reads.
 */
type ListenerFn<T = unknown> = (event: T) => unknown

// `abstract new`: a listener bound against an abstract base is as valid a
// registration as one bound against a concrete class, and the container builds
// either.
type ListenerConstructor<T = unknown> = abstract new (...args: never[]) => ListenerClass<T>

/** Any class a `[Class, 'method']` tuple may name: the method is checked when it runs. */
type AnyListenerConstructor = abstract new (...args: never[]) => object

/**
 * A module imported on first use, whose default export is the listener class:
 * `() => import('#listeners/send_welcome')`.
 */
export type LazyListenerImport = () => Promise<{ default: AnyListenerConstructor }>

/**
 * `[ListenerClass, method?]` or `[LazyImport, method?]` (AdonisJS). The method
 * defaults to `handle`.
 */
export type ListenerTuple =
  | readonly [AnyListenerConstructor | LazyListenerImport]
  | readonly [AnyListenerConstructor | LazyListenerImport, string]

/**
 * Every listener form an event accepts.
 *
 * Deviation from AdonisJS (named): its `'#listeners/x.method'` string form is
 * not accepted. It needs the application's module importer, which the emitter
 * does not hold; a lazy tuple says the same thing and type-checks.
 */
export type Listener<T = unknown> = ListenerFn<T> | ListenerConstructor<T> | ListenerTuple

/** What every listener form is turned into: called with the event's data. */
type NormalizedListener = (data: unknown) => Promise<unknown>

/** A class event or a string event — the two kinds every API accepts. */
type EventKey = EventConstructor | string

/** A wildcard listener: the event's name, and the emitted value. */
type AnyListener = (eventName: string, data: unknown) => unknown

/**
 * Resolver for instantiating listener classes with DI — the narrow shape the
 * emitter needs, so a test can hand it a fake without building a container.
 * The real {@link import('../container/ContainerResolver.js').ContainerResolver}
 * satisfies it.
 */
export interface EmitterResolver {
  /**
   * Build a listener.
   *
   * Not generic: a generic method must work for every `T`, so nothing but a
   * real container could implement it — the fake in the tests could not, and
   * this file's own call site reached for `as ListenerConstructor<T>` to get
   * past it. What comes back is checked below, which is what a container's
   * answer deserves anyway.
   */
  make(target: abstract new (...args: never[]) => object): Promise<object>
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
  #bus: EventBus
  #resolver?: EmitterResolver
  /**
   * Listeners per event, class or string: the listener as registered → the
   * function it was normalized to. Keyed by the original so `off()` finds it,
   * and a listener registered twice runs once, as AdonisJS (emittery) does.
   */
  readonly #listeners = new Map<EventKey, Map<Listener | NormalizedListener, NormalizedListener>>()
  /** Set while faking; every emission lands here instead of running. */
  #buffer?: EventsBuffer
  /** Which events are faked. `undefined` means all of them. */
  #fakedEvents?: Set<BufferedEventName>
  /** Wildcard subscriptions, so `offAny(listener)` can find its Rust handle. */
  readonly #anySubscriptions = new Map<AnyListener, Set<number>>()
  /** Observers told of every emission as it happens — see {@link tap}. */
  readonly #taps = new Set<(event: string, data: unknown) => void>()

  constructor(bus: EventBus, resolver?: EmitterResolver) {
    this.#bus = bus
    this.#resolver = resolver
  }

  // ─── Registering listeners ────────────────────────────────

  /**
   * Listen for a class-based event.
   *   emitter.on(TaskDeclared, [SendNotification])      // listener class
   *   emitter.on(TaskDeclared, [() => import('#listeners/notify'), 'handle'])
   *   emitter.on(TaskDeclared, (event) => { ... })       // inline function
   */
  on<T>(event: EventConstructor<T>, listener: Listener<T>): UnsubscribeFunction
  /**
   * Listen for a string-based event.
   *   emitter.on('user:registered', (user) => { ... })
   *   emitter.on<User>('user:registered', (user) => { ... })  // typed payload
   *   emitter.on('user:registered', [SendWelcome, 'handle'])
   *
   * Returns an unsubscribe function, as AdonisJS does — keeping the listener
   * reference around just to pass it back to `off` is the boilerplate that
   * function removes.
   */
  on<T>(event: string, listener: Listener<T>): UnsubscribeFunction
  on(event: EventKey, listener: Listener): UnsubscribeFunction {
    return this.#register(event, listener)
  }

  #register(event: EventKey, listener: Listener): UnsubscribeFunction {
    const listeners = this.#listenersOf(event)
    if (!listeners.has(listener)) listeners.set(listener, this.#normalize(listener))
    return () => {
      this.off(event, listener)
    }
  }

  /**
   * Listen for the NEXT occurrence only (AdonisJS `once`).
   *
   * The listener removes itself before running, so a handler that emits the
   * same event does not re-enter it. As in AdonisJS, `off(event, listener)`
   * does not reach it: it is registered under a wrapper of its own.
   */
  once<T>(event: EventConstructor<T>, listener: Listener<T>): void
  once<T>(event: string, listener: Listener<T>): void
  once(event: EventKey, listener: Listener): void {
    const normalized = this.#normalize(listener)
    const listeners = this.#listenersOf(event)
    const wrapper: NormalizedListener = async (data) => {
      listeners.delete(wrapper)
      if (listeners.size === 0 && this.#listeners.get(event) === listeners) {
        this.#listeners.delete(event)
      }
      return normalized(data)
    }
    listeners.set(wrapper, wrapper)
  }

  /**
   * Register the listener only when `condition` holds (AdonisJS `listenIf`) —
   * the shape a feature flag takes at boot, without an `if` around every call.
   * Returns the unsubscribe function, a no-op when nothing was registered.
   */
  listenIf<T>(
    condition: boolean | (() => boolean),
    event: EventConstructor<T>,
    listener: Listener<T>,
  ): UnsubscribeFunction
  listenIf<T>(
    condition: boolean | (() => boolean),
    event: string,
    listener: Listener<T>,
  ): UnsubscribeFunction
  listenIf(
    condition: boolean | (() => boolean),
    event: EventKey,
    listener: Listener,
  ): UnsubscribeFunction {
    // AdonisJS takes either — a thunk lets the flag be read at registration
    // time rather than at the call site.
    if (!(typeof condition === 'function' ? condition() : condition)) return () => {}
    return this.#register(event, listener)
  }

  /**
   * Bind several listener classes to one event (AdonisJS `listen`): each is
   * registered as `[listener, 'handle']`, eager class or lazy import alike.
   *
   *   emitter.listen(UserRegistered, [SendVerificationEmail, () => import('#listeners/audit')])
   */
  listen(
    event: EventKey,
    listeners: ReadonlyArray<AnyListenerConstructor | LazyListenerImport>,
  ): void {
    for (const listener of listeners) this.#register(event, [listener, 'handle'])
  }

  /**
   * Report listener failures (AdonisJS `onError`).
   *
   * Deviation (named): AdonisJS keeps ONE handler and replaces it on each
   * call; here each call adds one, on the `emitter:error` event.
   */
  onError(listener: (event: string, error: unknown) => void): void {
    this.on('emitter:error', (payload) => {
      const detail = isPlainObject(payload) ? payload : {}
      listener(typeof detail.event === 'string' ? detail.event : 'unknown', detail.error)
    })
  }

  /**
   * Remove one listener from an event (AdonisJS `off`). A tuple matches a
   * registered tuple naming the same target and method.
   */
  off(event: EventKey, listener: Listener): void {
    const listeners = this.#listeners.get(event)
    if (!listeners) return
    const key = Array.isArray(listener)
      ? [...listeners.keys()].find(
          (registered) =>
            Array.isArray(registered) &&
            registered[0] === listener[0] &&
            registered[1] === listener[1],
        )
      : listener
    if (key !== undefined) listeners.delete(key)
    if (listeners.size === 0) this.#listeners.delete(event)
  }

  /** Alias of {@link off} (AdonisJS `clearListener`). */
  clearListener(event: EventKey, listener: Listener): void {
    this.off(event, listener)
  }

  /** Drop every listener of one event (AdonisJS `clearListeners`). */
  clearListeners(event: EventKey): void {
    this.#listeners.delete(event)
  }

  /**
   * Drop every listener of every event (AdonisJS `clearAllListeners`) —
   * wildcard ones included, as emittery's `clearListeners()` drops its
   * `onAny` listeners. Their native unsubscriptions are not awaited; await
   * {@link offAny} when an assertion depends on one being gone.
   */
  clearAllListeners(): void {
    this.#listeners.clear()
    const ids = [...this.#anySubscriptions.values()].flatMap((set) => [...set])
    this.#anySubscriptions.clear()
    for (const id of ids) {
      void this.#bus
        .unsubscribe(id)
        .catch((err: unknown) => this.#emitError('emitter:offAny', fromNativeError(err)))
    }
  }

  /**
   * Every event with the listeners registered for it (AdonisJS
   * `eventsListeners`).
   *
   * Read-only copies: a caller inspecting the map — a debug screen, a test
   * asserting nothing leaked — must not be able to unsubscribe by mutating it.
   */
  get eventsListeners(): Map<EventKey, Array<Listener | NormalizedListener>> {
    const all = new Map<EventKey, Array<Listener | NormalizedListener>>()
    for (const [event, listeners] of this.#listeners) all.set(event, [...listeners.keys()])
    return all
  }

  /** How many listeners an event has, or all of them (AdonisJS `listenerCount`). */
  listenerCount(event?: EventKey): number {
    if (event !== undefined) return this.#listeners.get(event)?.size ?? 0
    let total = 0
    for (const listeners of this.#listeners.values()) total += listeners.size
    return total
  }

  /**
   * Check if any listeners are registered for an event, or for any event when
   * none is named (AdonisJS `hasListeners`).
   */
  hasListeners(event?: EventKey): boolean {
    return this.listenerCount(event) > 0
  }

  #listenersOf(event: EventKey): Map<Listener | NormalizedListener, NormalizedListener> {
    let listeners = this.#listeners.get(event)
    if (!listeners) {
      listeners = new Map()
      this.#listeners.set(event, listeners)
    }
    return listeners
  }

  /**
   * Turn any accepted listener form into one callable (AdonisJS
   * `#normalizeEventListener`, with fold's `moduleCaller` / `moduleImporter`).
   */
  #normalize(listener: Listener): NormalizedListener {
    if (isListenerTuple(listener)) {
      const [target, method = 'handle'] = listener
      if (isConstructor(target)) {
        return async (data) => this.#callListener(target, method, data)
      }
      // Lazy: imported on first use and kept, so the module and what it
      // pulls in (mailers, queues) stay out of the boot path.
      let imported: AnyListenerConstructor | undefined
      return async (data) => {
        imported ??= await importDefault(target)
        return this.#callListener(imported, method, data)
      }
    }
    if (isListenerClass(listener)) {
      return async (data) => this.#callListener(listener, 'handle', data)
    }
    if (isConstructor(listener)) {
      // A class with no `handle`: the call below names the problem instead of
      // invoking a constructor as a function.
      return async (data) => this.#callListener(listener, 'handle', data)
    }
    return async (data) => listener(data)
  }

  /** Build the listener (through the resolver when there is one) and call `method`. */
  async #callListener(
    target: AnyListenerConstructor,
    method: string,
    data: unknown,
  ): Promise<unknown> {
    const instance = this.#resolver
      ? await this.#resolver.make(target)
      : Reflect.construct(target, [])
    const handler: unknown = Reflect.get(instance, method)
    if (typeof handler !== 'function') {
      throw new E_EVENTS_MISSING_LISTENER_METHOD([method, String(Reflect.get(target, 'name'))])
    }
    return Reflect.apply(handler, instance, [data])
  }

  // ─── Emit ─────────────────────────────────────────────────

  /**
   * Watch every emission — string and class-based — as it happens.
   *
   * Development tooling: the profiler's events panel. `onAny` is not enough for
   * it, because a wildcard subscription goes through the native bus and is
   * called later, outside the request that emitted. A tap runs synchronously,
   * in the emitting code's own async context, before any listener.
   *
   * It observes and nothing more: it sees a faked event too, it cannot change
   * or cancel the emission, and a tap that throws is ignored.
   */
  tap(observer: (event: string, data: unknown) => void): UnsubscribeFunction {
    this.#taps.add(observer)
    return () => {
      this.#taps.delete(observer)
    }
  }

  #notifyTaps(event: string, data: unknown): void {
    for (const observer of this.#taps) {
      try {
        observer(event, data)
      } catch {
        // Observation must never break the emission it watches.
      }
    }
  }

  /**
   * Run an event's listeners, in parallel or one after another.
   *
   * A listener that throws is reported and does NOT stop the others: one
   * failing subscriber must not silently cancel the rest of the reaction to an
   * event it does not own.
   */
  async #dispatchListeners(
    event: EventKey,
    name: string,
    data: unknown,
    serial: boolean,
  ): Promise<void> {
    // `onAny` listeners are not here: they subscribe through the native bus,
    // which delivers every matching event to them on its own.
    const listeners = [...(this.#listeners.get(event)?.values() ?? [])]
    if (listeners.length === 0) return
    const run = async (fn: NormalizedListener): Promise<void> => {
      try {
        await fn(data)
      } catch (err) {
        this.#emitError(name, err)
      }
    }
    if (serial) {
      for (const fn of listeners) await run(fn)
      return
    }
    await Promise.all(listeners.map(run))
  }

  /**
   * Emit and run the listeners ONE AT A TIME (AdonisJS `emitSerial`).
   *
   * Use it when order matters — a listener that seeds what the next one reads.
   */
  async emitSerial(event: string, data: unknown): Promise<void> {
    this.#notifyTaps(event, data)
    if (this.#capture(event, data)) return
    await this.#dispatchListeners(event, event, data, true)
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
    this.#notifyTaps(event, data)
    if (this.#capture(event, data)) return
    await this.#dispatchListeners(event, event, data, false)
    this.#publishToBus(event, data)
  }

  /**
   * Push the event onto the bus for wildcard / cross-service subscribers.
   *
   * The payload goes as the caller gave it; the active correlation id rides
   * on the envelope, out of band. It used to be merged into the payload, so a
   * wildcard listener saw a `correlationId` key nobody emitted.
   */
  #publishToBus(event: string, data: unknown): void {
    // Serialize INSIDE the guard. `JSON.stringify` throws synchronously on a
    // cycle or a BigInt, and it was evaluated as an argument — so the throw
    // escaped past the `.catch` and crashed the caller.
    let payload: string
    try {
      payload = encodePayload(data)
    } catch (err) {
      this.#emitError(event, err)
      return
    }
    void this.#bus.emit(event, payload, correlationStorage.getStore()).catch((err: unknown) => {
      this.#emitError(event, fromNativeError(err))
    })
  }

  /** Emit an error event for listener failures. */
  #emitError(event: string, error: unknown): void {
    const errorListeners = [...(this.#listeners.get('emitter:error')?.values() ?? [])]
    if (errorListeners.length > 0) {
      for (const fn of errorListeners) {
        // Not awaited, and a rejection is dropped: reporting a failure must
        // not loop back into this method.
        fn({ event, error }).catch(() => {})
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
    const EventClass: unknown = event.constructor
    // Only an object without a prototype chain has none; nothing listens to it.
    if (!isEventConstructor(EventClass)) return
    const eventName: unknown = Reflect.get(EventClass, 'eventName')
    const name = typeof eventName === 'string' ? eventName : classToEventName(EventClass)
    this.#notifyTaps(name, event)
    // Faked by the class, as AdonisJS does — `fake([TaskDeclared])` catches
    // `new TaskDeclared(...).emit()`.
    if (this.#capture(EventClass, event)) return

    // Per-listener error isolation — mirrors the string `emit()` contract.
    // A side-effect listener that throws (SMTP down, etc.) MUST NOT abort
    // the sibling listeners NOR suppress the cross-service `bus.emit` below:
    // the domain event already happened, so distributed subscribers must
    // still receive it. Failures surface on the `emitter:error` channel.
    await this.#dispatchListeners(EventClass, name, event, true)

    // Also push through EventBus, with the correlation id on the envelope as
    // for string events. Reached unconditionally: a listener failure above no
    // longer skips it.
    this.#publishToBus(name, event)
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
   *
   * The listener gets the event's name and the emitted value, once per
   * matching event, and runs with the correlation id that was active where
   * the event was emitted (`getCorrelationId()`).
   *
   * Deviation (named): the value crosses the native bus as JSON, so the
   * listener receives a copy — a class event arrives as a plain object, a
   * `Date` as its ISO string — and the name of a class event is its
   * `eventName`, not the class. AdonisJS (emittery) hands over the same
   * reference, because its bus is in-process JavaScript.
   *
   * A listener that throws or rejects is reported like any other listener
   * (`onError` / `emitter:error`) and never reaches the native callback.
   */
  async onAny(listener: AnyListener): Promise<AsyncUnsubscribeFunction>
  async onAny(pattern: string, listener: AnyListener): Promise<AsyncUnsubscribeFunction>
  async onAny(
    patternOrListener: string | AnyListener,
    maybeListener?: AnyListener,
  ): Promise<AsyncUnsubscribeFunction> {
    // `onAny(listener)` — every event, the AdonisJS signature. `**` is the
    // deep-match pattern the Rust matcher already understands, so the two
    // forms share one implementation.
    const pattern = typeof patternOrListener === 'string' ? patternOrListener : '**'
    const listener = typeof patternOrListener === 'string' ? maybeListener : patternOrListener
    if (listener === undefined) {
      throw new E_EVENTS_INVALID_ARGUMENT(['onAny() requires a listener'])
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

  async #subscribeAny(pattern: string, listener: AnyListener): Promise<number> {
    return this.#bus.subscribe(pattern, (eventJson: string) => {
      // Two separate steps. They shared one try, so a listener that threw
      // was taken for an unreadable envelope and called AGAIN with the pattern
      // and the raw JSON — and its second throw left through the native
      // callback as an uncaught exception.
      const delivery = readDelivery(eventJson, pattern)
      // `run`, not `enterWith`: the id is the listener's, and must not stick
      // to whatever the native callback's context schedules next.
      correlationStorage.run(delivery.correlationId, () => {
        let outcome: unknown
        try {
          outcome = listener(delivery.name, delivery.data)
        } catch (err) {
          this.#emitError(delivery.name, err)
          return
        }
        if (isThenable(outcome)) {
          outcome.then(undefined, (err: unknown) => this.#emitError(delivery.name, err))
        }
      })
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
  async offAny(listenerOrId: number | AnyListener): Promise<this> {
    if (typeof listenerOrId === 'number') {
      await callNativeAsync(() => this.#bus.unsubscribe(listenerOrId))
      for (const ids of this.#anySubscriptions.values()) ids.delete(listenerOrId)
      return this
    }

    const ids = this.#anySubscriptions.get(listenerOrId)
    if (!ids) return this
    this.#anySubscriptions.delete(listenerOrId)
    await Promise.all([...ids].map((id) => callNativeAsync(() => this.#bus.unsubscribe(id))))
    return this
  }

  /** Check if a pattern matches an event name (wildcard matching via Rust). */
  matchesPattern(pattern: string, eventName: string): boolean {
    return this.#bus.matchesWildcard(pattern, eventName)
  }

  // ─── Request / Reply ──────────────────────────────────────

  /**
   * Send a request event and await a response.
   *
   *   const user = await emitter.request('query:user.find', { id: 1 })
   *
   * The active correlation id travels on the envelope, as for `emit`, so the
   * responder registered with {@link onRequest} runs under it.
   */
  async request<T = unknown>(name: string, data: unknown, timeoutMs = 5000): Promise<T> {
    // A request no handler answers, or that times out, rejects with its
    // coded error (E_EVENTS_NO_REQUEST_HANDLER, E_EVENTS_TIMEOUT…).
    const result = await callNativeAsync(() =>
      this.#bus.request(name, JSON.stringify(data), timeoutMs, correlationStorage.getStore()),
    )
    try {
      return JSON.parse(result) as T
    } catch {
      return result as T
    }
  }

  /**
   * Register a request handler.
   *
   *   emitter.onRequest('query:user.find', (eventJson, reply) => {
   *     const { data } = JSON.parse(eventJson)
   *     reply(JSON.stringify(db.find(JSON.parse(data).id)))
   *   })
   *
   * The handler runs with the requester's correlation id
   * (`getCorrelationId()`).
   *
   * A handler that throws or rejects ends the request at once: the
   * requester's `request()` rejects with `E_EVENTS_HANDLER_FAILED` (carrying
   * the handler's message) and the failure is reported like a listener's
   * (`onError` / `emitter:error`). It never leaves through the native
   * callback, where it would be an uncaught exception that ends the process.
   */
  onRequest(
    name: string,
    handler: (eventJson: string, reply: (response: string) => void) => void,
  ): void {
    this.#bus.onRequest(
      name,
      (eventJson: string, reply: (response: string) => void, fail: (message: string) => void) => {
        const refuse = (err: unknown): void => {
          this.#emitError(name, err)
          fail(`Request handler for '${name}' failed: ${errorMessage(err)}`)
        }
        const { correlationId } = readDelivery(eventJson, name)
        correlationStorage.run(correlationId, () => {
          let outcome: unknown
          try {
            outcome = handler(eventJson, reply)
          } catch (err) {
            refuse(err)
            return
          }
          if (isThenable(outcome)) outcome.then(undefined, refuse)
        })
      },
    )
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

  // ─── Introspection ────────────────────────────────────────

  /** Get the number of Rust-side subscriptions. */
  async subscriptionCount(): Promise<number> {
    return callNativeAsync(() => this.#bus.subscriptionCount())
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

/** A class event: any function can be one, as any object has a constructor. */
function isEventConstructor(value: unknown): value is EventConstructor {
  return typeof value === 'function'
}

/** A listener class: it has a `handle` method (the bare-class shorthand). */
function isListenerClass(listener: Listener): listener is ListenerConstructor {
  return (
    typeof listener === 'function' &&
    typeof Reflect.get(Reflect.get(listener, 'prototype') ?? {}, 'handle') === 'function'
  )
}

function isListenerTuple(listener: Listener): listener is ListenerTuple {
  return Array.isArray(listener)
}

/**
 * Whether a function is a class rather than a lazy import or a plain listener
 * (`@sindresorhus/is` `class`, which AdonisJS uses, reads the source the same
 * way). A function with methods on its prototype counts too, for classes
 * compiled down to functions.
 */
function isConstructor(value: unknown): value is AnyListenerConstructor {
  if (typeof value !== 'function') return false
  if (/^class[\s{]/.test(Function.prototype.toString.call(value))) return true
  const prototype: unknown = Reflect.get(value, 'prototype')
  return (
    prototype !== null &&
    typeof prototype === 'object' &&
    Object.getOwnPropertyNames(prototype).some((name) => name !== 'constructor')
  )
}

/** The default export of a lazily imported listener module, checked. */
async function importDefault(importer: LazyListenerImport): Promise<AnyListenerConstructor> {
  const module: unknown = await importer()
  const exported: unknown =
    module !== null && typeof module === 'object' ? Reflect.get(module, 'default') : undefined
  if (!isConstructor(exported)) {
    throw new E_APP_MISSING_DEFAULT_EXPORT([
      `Missing "export default" of a listener class in the module imported by ${importer.name || 'a lazy listener'}`,
    ])
  }
  return exported
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'then') === 'function'
  )
}

/**
 * The payload as it crosses the bus. `undefined` — an event emitted with no
 * data — has no JSON form, so it travels as the empty string, which no JSON
 * value serializes to.
 */
function encodePayload(data: unknown): string {
  return data === undefined ? '' : JSON.stringify(data)
}

/** The value {@link encodePayload} produced; a non-JSON string stays a string. */
function decodePayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  if (raw === '') return undefined
  try {
    return safeJsonParse(raw)
  } catch {
    return raw
  }
}

interface Delivery {
  name: string
  data: unknown
  correlationId: string | undefined
}

/**
 * Read the envelope the native bus delivers (`crates/ream-events` `Event`):
 * the event's name, its payload decoded, and the correlation id it carries.
 * An unreadable envelope is delivered as the raw string under `fallbackName`.
 */
function readDelivery(eventJson: string, fallbackName: string): Delivery {
  let envelope: unknown
  try {
    envelope = JSON.parse(eventJson)
  } catch {
    return { name: fallbackName, data: eventJson, correlationId: undefined }
  }
  if (!isPlainObject(envelope)) {
    return { name: fallbackName, data: envelope, correlationId: undefined }
  }
  return {
    name: typeof envelope.name === 'string' ? envelope.name : fallbackName,
    data: decodePayload(envelope.data),
    correlationId: typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined,
  }
}

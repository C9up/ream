/**
 * `@c9up/ream/events` — the event bus, part of ream core. A basic
 * in-process emitter works with zero external
 * infrastructure; the Redis store is an opt-in `redis-store` build feature.
 *
 * App-facing surface: `Emitter` (string + class events, wildcard, request/
 * reply), `BaseEvent` (typed event classes), and `EventsProvider` (wires the
 * `events`/`emitter` container tokens). The Rust-backed `EventBus` is the
 * low-level native binding, exposed for advanced use.
 */

export type { EventsConfig } from './config.js'
export { defineConfig } from './config.js'
export type { AsyncUnsubscribeFunction, UnsubscribeFunction } from './Emitter.js'
export {
  BaseEvent,
  type ContainerResolver,
  Emitter,
  type ListenerClass,
} from './Emitter.js'
export {
  type BufferedEvent,
  type BufferedEventName,
  type EventFinder,
  EventsBuffer,
} from './EventsBuffer.js'
export type { EventsAppContext } from './EventsProvider.js'
export { default as EventsProvider } from './EventsProvider.js'
export { EventBus } from './native.js'

/**
 * Native event-bus loader. Resolves the Rust-backed `events.<platform>.node`
 * binary (built from the `ream-events-napi` crate) via the shared
 * `loadNapi` helper and re-exports the `EventBus` class it provides.
 *
 * The bus is part of ream core: a basic in-process
 * emitter works with zero external infrastructure; the Redis store is an
 * opt-in `redis-store` cargo feature for durable/distributed production use.
 */

import { loadNapi } from '../helpers/napi-loader.js'

/** Rust-backed bus surface (mirrors the napi `#[napi] EventBus` exports). */
export interface EventBus {
  emit(name: string, data: string): Promise<string>
  subscribe(pattern: string, callback: (eventJson: string) => void): number
  unsubscribe(subscriptionId: number): Promise<void>
  onRequest(
    name: string,
    callback: (eventJson: string, reply: (response: string) => void) => void,
  ): void
  request(name: string, data: string, timeoutMs?: number): Promise<string>
  matchesWildcard(pattern: string, eventName: string): boolean
  subscriptionCount(): Promise<number>
}

interface EventsNative {
  EventBus: new (requestHandlerTimeoutMs?: number) => EventBus
}

const native = loadNapi<EventsNative>({
  binaryName: 'events',
  callerMetaUrl: import.meta.url,
  errorCodePrefix: 'EVENTS',
})

export const EventBus = native.EventBus

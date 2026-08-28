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

/**
 * Rust-backed bus surface.
 *
 * Re-exported from the generated declarations rather than restated here: the
 * shape is derived from the `#[napi]` items themselves, so it cannot drift
 * from the Rust. It did before — making `Bus::on_request` synchronous changed
 * the Rust with nothing on this side to notice.
 *
 * Run `pnpm build:napi-types` after touching a `#[napi]` signature.
 */
import type { EventBus as NativeEventBus } from '../native/generated.js'

/**
 * What the `events` binary exports.
 *
 * The instance shape comes from the generated declarations — derived from the
 * `#[napi]` items, so it cannot drift from the Rust without the generated file
 * changing. Only the constructor is named here, because the binary is a module
 * object rather than a class the loader can see.
 */
interface EventsNative {
  EventBus: new (requestHandlerTimeoutMs?: number) => NativeEventBus
}

const native = loadNapi<EventsNative>({
  binaryName: 'events',
  callerMetaUrl: import.meta.url,
  errorCodePrefix: 'EVENTS',
})

export const EventBus = native.EventBus
export type EventBus = NativeEventBus

import { EventsError } from '../errors/ModuleErrors.js'

/**
 * `config/events.ts`.
 *
 * Only what the provider actually honours is declared. `store: 'redis'` and
 * `retries` used to be scaffolded and read by nothing: the Rust bus has a store
 * and a retry loop (`Bus::with_store`, `subscribe_with_retry`), but neither is
 * reachable from JavaScript, so an app configured for a durable store kept the
 * in-memory bus without a word. They are refused at boot now (see
 * {@link checkEventsConfig}) until they are wired end to end.
 */
export interface EventsConfig {
  /** Where events live. `'memory'`, the default and the only store this build has. */
  store?: 'memory'
}

export function defineConfig(config: EventsConfig): EventsConfig {
  return config
}

/**
 * Check `config/events.ts` before the bus is built: a value nothing would
 * honour fails the boot with a named error instead of being ignored.
 *
 * - `E_EVENTS_UNSUPPORTED_STORE` — a `store` other than `'memory'`.
 * - `E_EVENTS_UNSUPPORTED_OPTION` — any other key (`retries` included).
 */
export function checkEventsConfig(config: unknown): EventsConfig {
  if (config === undefined || config === null) return { store: 'memory' }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new EventsError('E_EVENTS_UNSUPPORTED_OPTION', 'config/events.ts must export an object', {
      hint: "export default defineConfig({ store: 'memory' })",
    })
  }
  for (const key of Object.keys(config)) {
    if (key !== 'store') {
      throw new EventsError(
        'E_EVENTS_UNSUPPORTED_OPTION',
        `config/events.ts: '${key}' is not an events option`,
        {
          hint:
            key === 'retries'
              ? 'Delivery retries are not available from JavaScript yet; remove the option.'
              : "The only option is store: 'memory'.",
        },
      )
    }
  }
  const store: unknown = Reflect.get(config, 'store')
  if (store !== undefined && store !== 'memory') {
    throw new EventsError(
      'E_EVENTS_UNSUPPORTED_STORE',
      `config/events.ts: store '${String(store)}' is not available`,
      {
        hint: "Only the in-memory store exists in this build; use store: 'memory'.",
      },
    )
  }
  return { store: 'memory' }
}

/**
 * Base Provider class — modules register via providers.
 *
 * @implements FR20
 *
 * Lifecycle (AdonisJS-compatible):
 *   register() → boot() → start() → ready() → ... → shutdown()
 */

import type { Container } from './container/Container.js'

/**
 * The config a provider reads, as a CONTRACT rather than as the class.
 *
 * `ConfigStore` satisfies it, so nothing that holds a real one changes. But
 * typed as the class, `AppContext` demanded a private `#tree` no one outside
 * `ConfigLoader` can produce — so a test could not substitute a config, and an
 * independently-published package could not describe an `AppContext` at all
 * without importing `@c9up/ream`, which is the coupling the comment below this
 * one exists to avoid. bay, station and blackhole each re-declared their own
 * for exactly that reason.
 *
 * `get` and `set` are what providers actually use; a `ConfigStore`'s other
 * methods stay reachable on the concrete type.
 */
export interface ConfigReader {
  get<T = unknown>(key: string): T | undefined
  get<T = unknown>(key: string, defaultValue: T): T
  set(key: string, value: unknown): void
}

export interface AppContext {
  container: Container
  config: ConfigReader
}

/**
 * Structural contract for a provider — all phases optional. Independently-
 * published packages (spectrum, warden, blackhole, relay, ...) implement
 * only the phases they need without taking a hard dependency on
 * `@c9up/ream`. The lifecycle runner guards each call with a `typeof`
 * check, so a missing method is opt-out, not a contract break.
 *
 * The abstract `Provider` class below is the convenience implementation
 * for code that *does* live inside this package — it ships empty
 * defaults for every phase. Both shapes satisfy `ProviderContract`.
 */
export interface ProviderContract {
  register?(): void
  boot?(): Promise<void> | void
  start?(): Promise<void> | void
  ready?(): Promise<void> | void
  shutdown?(): Promise<void> | void
}

/**
 * Invoke an async lifecycle phase on a provider, ignoring it when the
 * method is absent. Centralises the duck-type guard that the lifecycle
 * runner has to do at every phase since `ProviderContract` makes them
 * all optional.
 */
export async function callProviderPhase(
  provider: ProviderContract,
  phase: 'boot' | 'start' | 'ready' | 'shutdown',
): Promise<void> {
  const fn = provider[phase]
  if (typeof fn === 'function') {
    await fn.call(provider)
  }
}

export abstract class Provider implements ProviderContract {
  protected app: AppContext

  constructor(app: AppContext) {
    this.app = app
  }

  /** Phase 1: Register bindings in the container (synchronous). */
  register(): void {}

  /** Phase 2: Boot — framework setup, verify connections. */
  async boot(): Promise<void> {}

  /** Phase 3: Start — before HTTP server starts. Import routes, warm caches. */
  async start(): Promise<void> {}

  /** Phase 4: Ready — app fully operational, HTTP server listening. */
  async ready(): Promise<void> {}

  /** Cleanup on shutdown (reverse order). */
  async shutdown(): Promise<void> {}
}

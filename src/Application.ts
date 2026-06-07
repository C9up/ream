/**
 * Application — manages providers, config, lifecycle, and signal handling.
 *
 * Like AdonisJS Application:
 * - app.booting(callback) — register hooks that run during boot
 * - app.booted(callback) — register hooks that run after boot completes
 * - app.listen(signal, callback) — listen for process signals
 * - app.listenIf(condition, signal, callback) — conditional signal listener
 * - app.terminate() — graceful shutdown
 * - app.managedByPm2 — PM2 detection
 * - app.inProduction / app.inDev / app.inTest
 *
 * @implements FR17, FR20
 */

import { ConfigStore } from './ConfigLoader.js'
import { Container } from './container/Container.js'
import type { AppContext, ConfigStoreContract, ProviderContract } from './Provider.js'
import { callProviderPhase } from './Provider.js'

export class Application implements AppContext {
  readonly container: Container
  readonly config: ConfigStoreContract
  private providers: ProviderContract[] = []
  private _booted = false
  private _bootingHooks: Array<() => Promise<void> | void> = []
  private _bootedHooks: Array<() => Promise<void> | void> = []
  private _shutdownHooks: Array<() => Promise<void> | void> = []

  constructor() {
    this.container = new Container()
    this.config = new ConfigStore()
  }

  // ─── Environment ──────────────────────────────────────────

  /** Check if running in production. */
  get inProduction(): boolean {
    return process.env.NODE_ENV === 'production'
  }

  /** Check if running in development. */
  get inDev(): boolean {
    const env = process.env.NODE_ENV
    return env !== 'production' && env !== 'test'
  }

  /** Check if running in test mode. */
  get inTest(): boolean {
    return process.env.NODE_ENV === 'test'
  }

  /** Check if managed by PM2. */
  get managedByPm2(): boolean {
    return 'PM2_HOME' in process.env || 'pm_id' in process.env
  }

  // ─── Lifecycle hooks ──────────────────────────────────────

  /**
   * Register a callback that runs during the boot phase (before providers boot).
   * Like AdonisJS app.booting().
   */
  booting(callback: () => Promise<void> | void): void {
    this._bootingHooks.push(callback)
  }

  /**
   * Register a callback that runs after boot completes.
   * Like AdonisJS app.booted().
   */
  booted(callback: () => Promise<void> | void): void {
    if (this._booted) {
      // Already booted — run immediately. Invoke callback() INSIDE the
      // promise chain (not as `Promise.resolve(callback())`, which
      // evaluates callback() eagerly and lets a synchronous throw
      // escape to the caller) so both sync throws and async rejections
      // are funnelled to the logger.
      Promise.resolve()
        .then(() => callback())
        .catch((err) => {
          process.stderr.write(`[Ream] booted() callback error: ${err}\n`)
        })
      return
    }
    this._bootedHooks.push(callback)
  }

  // ─── Signal handling ──────────────────────────────────────

  /**
   * Listen for a process signal.
   * Like AdonisJS app.listen('SIGTERM', () => app.terminate()).
   */
  listen(signal: NodeJS.Signals, callback: () => void): void {
    process.on(signal, callback)
  }

  /**
   * Conditionally listen for a process signal.
   * Like AdonisJS app.listenIf(app.managedByPm2, 'SIGINT', ...).
   */
  listenIf(condition: boolean, signal: NodeJS.Signals, callback: () => void): void {
    if (condition) {
      process.on(signal, callback)
    }
  }

  /**
   * Graceful shutdown — stop all providers and exit.
   * Like AdonisJS app.terminate().
   */
  async terminate(): Promise<void> {
    await this.shutdown()
    process.exit(0)
  }

  // ─── Provider lifecycle ───────────────────────────────────

  /** Register a provider instance. */
  register(provider: ProviderContract): void {
    this.providers.push(provider)
    if (typeof provider.register === 'function') {
      provider.register()
    }
  }

  /** Boot all registered providers. Runs booting/booted hooks. */
  async boot(): Promise<void> {
    if (this._booted) return

    // Run booting hooks
    for (const hook of this._bootingHooks) {
      await hook()
    }

    // Boot providers. `callProviderPhase` skips providers that don't
    // declare the phase — duck-typed packages (spectrum, warden, etc.)
    // implement only what they need.
    for (const provider of this.providers) {
      await callProviderPhase(provider, 'boot')
    }

    this._booted = true

    // Run booted hooks
    for (const hook of this._bootedHooks) {
      await hook()
    }
  }

  /** Shutdown all providers in reverse order. */
  async shutdown(): Promise<void> {
    // Run shutdown hooks
    for (const hook of this._shutdownHooks) {
      await hook()
    }

    for (const provider of [...this.providers].reverse()) {
      await callProviderPhase(provider, 'shutdown')
    }
    this._booted = false
  }

  /** Register a shutdown hook. */
  onShutdown(callback: () => Promise<void> | void): void {
    this._shutdownHooks.push(callback)
  }

  get isBooted(): boolean {
    return this._booted
  }

  get providerCount(): number {
    return this.providers.length
  }
}

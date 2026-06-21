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

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from './ConfigLoader.js'
import { Container } from './container/Container.js'
import type { AppContext, ProviderContract } from './Provider.js'
import { callProviderPhase } from './Provider.js'

export class Application implements AppContext {
  readonly container: Container
  readonly config: ConfigStore
  #appRoot?: URL
  private providers: ProviderContract[] = []
  private _booted = false
  private _bootingHooks: Array<() => Promise<void> | void> = []
  private _bootedHooks: Array<() => Promise<void> | void> = []
  private _shutdownHooks: Array<() => Promise<void> | void> = []

  constructor() {
    this.container = new Container()
    this.config = new ConfigStore()
  }

  // ─── Paths ────────────────────────────────────────────────
  // AdonisJS-style path helpers — resolve against the project root passed to
  // the Ignitor (`new Ignitor(new URL('../', import.meta.url))`). App code uses
  // these instead of recomputing `dirname(fileURLToPath(import.meta.url))` per
  // file: `app.configPath('shield.ts')`, `app.migrationsPath()`, …

  /** Set the project root. Called by the Ignitor from its constructor URL. */
  setAppRoot(root: URL): void {
    this.#appRoot = root
  }

  /** The project root directory URL, or `undefined` in inline/no-root mode. */
  get appRoot(): URL | undefined {
    return this.#appRoot
  }

  /** Absolute path to a file/dir inside the project root. */
  makePath(...paths: string[]): string {
    if (!this.#appRoot) {
      throw new Error(
        'Application.makePath: app root is not set — construct the Ignitor with `new Ignitor(new URL("../", import.meta.url))`.',
      )
    }
    return join(fileURLToPath(this.#appRoot), ...paths)
  }

  /** Absolute path inside the `config/` directory. */
  configPath(...paths: string[]): string {
    return this.makePath('config', ...paths)
  }

  /** Absolute path inside the `database/migrations/` directory. */
  migrationsPath(...paths: string[]): string {
    return this.makePath('database', 'migrations', ...paths)
  }

  /** Absolute path inside the `tmp/` directory. */
  tmpPath(...paths: string[]): string {
    return this.makePath('tmp', ...paths)
  }

  /** Absolute path inside the `public/` directory. */
  publicPath(...paths: string[]): string {
    return this.makePath('public', ...paths)
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

  /** Signal handlers installed via listen()/listenIf(), removed on shutdown. */
  #signalHandlers: Array<[NodeJS.Signals, () => void]> = []

  /**
   * Listen for a process signal.
   * Like AdonisJS app.listen('SIGTERM', () => app.terminate()).
   * Tracked and removed on shutdown() — otherwise every boot/stop cycle leaks
   * a process listener, and a real signal would fire the handlers of every
   * previously stopped app instance.
   */
  listen(signal: NodeJS.Signals, callback: () => void): void {
    this.#signalHandlers.push([signal, callback])
    process.on(signal, callback)
  }

  /**
   * Conditionally listen for a process signal.
   * Like AdonisJS app.listenIf(app.managedByPm2, 'SIGINT', ...).
   */
  listenIf(condition: boolean, signal: NodeJS.Signals, callback: () => void): void {
    if (condition) {
      this.listen(signal, callback)
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

  /**
   * Shutdown all providers in reverse order. Each hook/provider shutdown is
   * isolated: one throwing provider must not prevent the remaining providers
   * from closing their resources (DB pools, queues). Errors are aggregated.
   */
  async shutdown(): Promise<void> {
    const errors: unknown[] = []

    for (const hook of this._shutdownHooks) {
      try {
        await hook()
      } catch (err) {
        errors.push(err)
      }
    }

    for (const provider of [...this.providers].reverse()) {
      try {
        await callProviderPhase(provider, 'shutdown')
      } catch (err) {
        errors.push(err)
      }
    }

    // Remove the process signal handlers this app installed.
    for (const [signal, callback] of this.#signalHandlers) {
      process.off(signal, callback)
    }
    this.#signalHandlers = []

    this._booted = false
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Application.shutdown() completed with errors')
    }
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

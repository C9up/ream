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

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore } from './ConfigLoader.js'
import { Container } from './container/Container.js'
import { type DirectoriesNode, directories as defaultDirectories } from './directories.js'
import { currentNodeEnv } from './env/nodeEnv.js'
import type { AppContext, ProviderContract } from './Provider.js'
import { callProviderPhase } from './Provider.js'

/**
 * How far the app intends to go in its lifecycle.
 *
 * `run` is a real boot. `warmup` means the app is being INSPECTED — a codegen
 * or listing command — so it will never become ready.
 */
export type ApplicationMode = 'run' | 'warmup'

/**
 * What the process is running as (AdonisJS `AppEnvironments`).
 *
 * Providers and preloads are filtered on it — a console-only provider must not
 * boot inside an HTTP request, and `ream repl` is not `ream serve`: a provider
 * that opens a connection pool for the web has no business doing it because
 * someone opened a shell.
 */
export type AppEnvironment = 'web' | 'console' | 'test' | 'repl' | 'unknown'

/**
 * Where the application is in its lifecycle (AdonisJS `ApplicationStates`).
 *
 * Read it rather than inferring from a boolean: "not booted" covers both
 * "starting up" and "already shut down", and code that guards on the wrong one
 * runs at exactly the wrong moment.
 */
export type ApplicationState =
  | 'created'
  | 'initiated'
  | 'booted'
  | 'ready'
  | 'terminating'
  | 'terminated'

export class Application implements AppContext {
  readonly container: Container
  readonly config: ConfigStore
  #appRoot?: URL
  #directories: DirectoriesNode = { ...defaultDirectories }
  #providers: ProviderContract[] = []
  #booted = false
  #environment: AppEnvironment = 'unknown'
  #state: ApplicationState = 'created'
  #packageJsonRead = false
  #packageJsonCache: { name?: string; version?: string } | undefined
  #mode: ApplicationMode = 'run'
  #bootingHooks: Array<() => Promise<void> | void> = []
  #bootedHooks: Array<() => Promise<void> | void> = []
  #shutdownHooks: Array<() => Promise<void> | void> = []

  constructor() {
    this.container = new Container()
    this.config = new ConfigStore()
  }

  /**
   * The current mode (AdonisJS `getMode`).
   *
   * A provider reads it to skip its SIDE EFFECTS — starting queue workers,
   * opening a connection — when the app is only being inspected. It must never
   * change which bindings are registered: the app being inspected has to match
   * the app that runs, or the generated types describe something else.
   *
   *   async start() {
   *     if (this.app.getMode() !== 'run') return
   *     await startQueueWorkers()
   *   }
   */
  getMode(): ApplicationMode {
    return this.#mode
  }

  /**
   * Switch the mode (AdonisJS `setMode`). Only before boot — afterwards the
   * side effects a provider skipped have already been skipped, and pretending
   * otherwise would leave the app half-started.
   */
  setMode(mode: ApplicationMode): this {
    if (this.#booted) {
      throw new Error(`Cannot switch to '${mode}' mode: the application is already booted.`)
    }
    this.#mode = mode
    return this
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
    return join(fileURLToPath(this.#requireAppRoot()), ...paths)
  }

  /**
   * A URL to a file/dir inside the project root, where {@link makePath} gives
   * a path. What an importer wants.
   */
  makeURL(...paths: string[]): URL {
    // Joined with '/', not `path.join`: a URL keeps forward slashes on every
    // platform, and `join` would hand Windows a backslash-separated href.
    return new URL(paths.join('/'), this.#requireAppRoot())
  }

  /** Turn an absolute path back into one relative to the project root. */
  relativePath(absolutePath: string): string {
    return relative(fileURLToPath(this.#requireAppRoot()), absolutePath)
  }

  #requireAppRoot(): URL {
    if (!this.#appRoot) {
      throw new Error(
        'Application.makePath: app root is not set — construct the Ignitor with `new Ignitor(new URL("../", import.meta.url))`.',
      )
    }
    return this.#appRoot
  }

  /**
   * The conventional directory layout, `reamrc.ts` overrides merged over the
   * defaults. Every helper below reads it, so moving a directory is declared
   * once.
   */
  get directories(): DirectoriesNode {
    return this.#directories
  }

  /**
   * Feed the loaded rc file to the application (AdonisJS `rcContents`).
   *
   * Today it reads one key, `directories`, merged over the defaults; the rest
   * of the rc file is consumed by the Ignitor and the CLI, which own providers,
   * preloads, commands and test suites.
   */
  rcContents(value: { directories?: Partial<DirectoriesNode> }): this {
    if (value.directories) {
      // Skip the undefined entries a `Partial` may carry: spreading them would
      // blank a default rather than leave it alone.
      for (const [key, path] of Object.entries(value.directories)) {
        if (path !== undefined) this.#directories[key] = path
      }
    }
    return this
  }

  /** Resolve inside one of the conventional directories. */
  #inDirectory(key: keyof DirectoriesNode, paths: string[]): string {
    return this.makePath(this.#directories[key], ...paths)
  }

  /** Absolute path inside the `config/` directory. */
  configPath(...paths: string[]): string {
    return this.#inDirectory('config', paths)
  }

  /** Absolute path inside the `database/migrations/` directory. */
  migrationsPath(...paths: string[]): string {
    return this.#inDirectory('migrations', paths)
  }

  /** Absolute path inside the `tmp/` directory. */
  tmpPath(...paths: string[]): string {
    return this.#inDirectory('tmp', paths)
  }

  /** Absolute path inside the `public/` directory. */
  publicPath(...paths: string[]): string {
    return this.#inDirectory('public', paths)
  }

  /** Absolute path inside the `providers/` directory. */
  providersPath(...paths: string[]): string {
    return this.#inDirectory('providers', paths)
  }

  /** Absolute path inside the `database/factories/` directory. */
  factoriesPath(...paths: string[]): string {
    return this.#inDirectory('factories', paths)
  }

  /** Absolute path inside the `database/seeders/` directory. */
  seedersPath(...paths: string[]): string {
    return this.#inDirectory('seeders', paths)
  }

  /** Absolute path inside the `resources/lang/` directory. */
  languageFilesPath(...paths: string[]): string {
    return this.#inDirectory('languageFiles', paths)
  }

  /** Absolute path inside the `resources/views/` directory. */
  viewsPath(...paths: string[]): string {
    return this.#inDirectory('views', paths)
  }

  /** Absolute path inside the `start/` directory. */
  startPath(...paths: string[]): string {
    return this.#inDirectory('start', paths)
  }

  /** Absolute path inside the `contracts/` directory. */
  contractsPath(...paths: string[]): string {
    return this.#inDirectory('contracts', paths)
  }

  /** Absolute path inside the `app/controllers/` directory. */
  httpControllersPath(...paths: string[]): string {
    return this.#inDirectory('httpControllers', paths)
  }

  /** Absolute path inside the `app/models/` directory. */
  modelsPath(...paths: string[]): string {
    return this.#inDirectory('models', paths)
  }

  /** Absolute path inside the `app/services/` directory. */
  servicesPath(...paths: string[]): string {
    return this.#inDirectory('services', paths)
  }

  /** Absolute path inside the `app/exceptions/` directory. */
  exceptionsPath(...paths: string[]): string {
    return this.#inDirectory('exceptions', paths)
  }

  /** Absolute path inside the `app/mailers/` directory. */
  mailersPath(...paths: string[]): string {
    return this.#inDirectory('mailers', paths)
  }

  /** Absolute path inside the `app/mails/` directory. */
  mailsPath(...paths: string[]): string {
    return this.#inDirectory('mails', paths)
  }

  /** Absolute path inside the `app/middleware/` directory. */
  middlewarePath(...paths: string[]): string {
    return this.#inDirectory('middleware', paths)
  }

  /** Absolute path inside the `app/policies/` directory. */
  policiesPath(...paths: string[]): string {
    return this.#inDirectory('policies', paths)
  }

  /** Absolute path inside the `app/validators/` directory. */
  validatorsPath(...paths: string[]): string {
    return this.#inDirectory('validators', paths)
  }

  /** Absolute path inside the `commands/` directory. */
  commandsPath(...paths: string[]): string {
    return this.#inDirectory('commands', paths)
  }

  /** Absolute path inside the `app/events/` directory. */
  eventsPath(...paths: string[]): string {
    return this.#inDirectory('events', paths)
  }

  /** Absolute path inside the `app/listeners/` directory. */
  listenersPath(...paths: string[]): string {
    return this.#inDirectory('listeners', paths)
  }

  /** Absolute path inside the `app/transformers/` directory. */
  transformersPath(...paths: string[]): string {
    return this.#inDirectory('transformers', paths)
  }

  /** Absolute path inside the generated-client directory (`.ream/client`). */
  generatedClientPath(...paths: string[]): string {
    return this.#inDirectory('generatedClient', paths)
  }

  /** Absolute path inside the generated-server directory (`.ream/server`). */
  generatedServerPath(...paths: string[]): string {
    return this.#inDirectory('generatedServer', paths)
  }

  // ─── Environment ──────────────────────────────────────────

  /** Check if running in production. */
  get inProduction(): boolean {
    return currentNodeEnv() === 'production'
  }

  /**
   * Check if running in development.
   *
   * An EXACT match, not "anything that is not production or test". An absent
   * `NODE_ENV` normalises to `unknown`, and a staging box says `staging` —
   * neither is development, and reading them as such turns on hot reload, the
   * GraphQL playground and full error pages on a machine nobody configured.
   */
  get inDev(): boolean {
    return currentNodeEnv() === 'development'
  }

  /** Check if running in test mode. */
  get inTest(): boolean {
    return currentNodeEnv() === 'test'
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
    this.#bootingHooks.push(callback)
  }

  /**
   * Register a callback that runs after boot completes.
   * Like AdonisJS app.booted().
   */
  booted(callback: () => Promise<void> | void): void {
    if (this.#booted) {
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
    this.#bootedHooks.push(callback)
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
   * What the process is running as (AdonisJS `getEnvironment`).
   *
   * Lives on the application, not on the Ignitor, because that is where a
   * provider reads it: `if (app.getEnvironment() !== 'web') return`.
   */
  getEnvironment(): AppEnvironment {
    return this.#environment
  }

  /**
   * Declare what the process is running as (AdonisJS `setEnvironment`).
   *
   * Refused after boot: providers and preloads were already filtered on the
   * old value, so changing it afterwards would describe an application that
   * was never assembled.
   */
  setEnvironment(environment: AppEnvironment): this {
    if (this.#booted) {
      throw new Error(
        `Cannot switch to the '${environment}' environment: the application is already booted.`,
      )
    }
    this.#environment = environment
    return this
  }

  /** The normalised `NODE_ENV`, or `'unknown'` when it is unset. */
  get nodeEnvironment(): string {
    return currentNodeEnv()
  }

  /** Where the application is in its lifecycle (AdonisJS `getState`). */
  getState(): ApplicationState {
    return this.#state
  }

  /** True once boot and every ready hook have completed (AdonisJS `isReady`). */
  get isReady(): boolean {
    return this.#state === 'ready'
  }

  /** True while shutdown hooks are running (AdonisJS `isTerminating`). */
  get isTerminating(): boolean {
    return this.#state === 'terminating'
  }

  /** True once shutdown has completed (AdonisJS `isTerminated`). */
  get isTerminated(): boolean {
    return this.#state === 'terminated'
  }

  /** The name from the app's `package.json`, when it could be read. */
  get appName(): string | undefined {
    return this.#packageJson()?.name
  }

  /** The version from the app's `package.json`, when it could be read. */
  get version(): string | undefined {
    return this.#packageJson()?.version
  }

  /**
   * A snapshot of the application, for a health endpoint or a bug report
   * (AdonisJS `toJSON`).
   */
  toJSON(): {
    appName: string | undefined
    version: string | undefined
    environment: AppEnvironment
    nodeEnvironment: string
    state: ApplicationState
    isReady: boolean
    isTerminating: boolean
  } {
    return {
      appName: this.appName,
      version: this.version,
      environment: this.#environment,
      nodeEnvironment: this.nodeEnvironment,
      state: this.#state,
      isReady: this.isReady,
      isTerminating: this.isTerminating,
    }
  }

  /**
   * Listen for a signal, then stop listening (AdonisJS `listenOnce`).
   *
   * Registered through {@link listen} so the handler is still removed by
   * `terminate()` when the signal never arrives — otherwise a stopped app
   * would leave a listener behind, and the next real signal would run the
   * handlers of every app instance that ever existed.
   */
  listenOnce(signal: NodeJS.Signals, callback: () => void): void {
    const once = (): void => {
      process.removeListener(signal, once)
      callback()
    }
    this.listen(signal, once)
  }

  /** {@link listenOnce}, only when `condition` holds (AdonisJS `listenOnceIf`). */
  listenOnceIf(condition: boolean, signal: NodeJS.Signals, callback: () => void): void {
    if (condition) this.listenOnce(signal, callback)
  }

  /**
   * Tell the process supervisor the app reached a state (AdonisJS `notify`).
   *
   * A no-op unless something is listening — systemd's `NOTIFY_SOCKET`, or a
   * parent process. Silent by design: an app should not fail to start because
   * nothing was there to hear it.
   */
  notify(message: unknown, callback?: (error: Error | null) => void): void {
    // Passed through verbatim, as upstream does. Wrapping it in an envelope
    // meant a supervisor waiting for the conventional `'ready'` string — the
    // systemd / pm2 idiom — received an object it did not recognise, and
    // waited out its start-up timeout instead.
    //
    // `unknown` rather than `string`: `process.send` takes any serialisable
    // value, and a supervisor that wants the port and the host in one message
    // should be able to send them.
    if (callback) process.send?.(message, undefined, undefined, callback)
    else process.send?.(message)
  }

  /**
   * Import a module and return its default export (AdonisJS `importDefault`).
   *
   * Throws when there is none, naming the file: a preload or provider entry
   * without a default export otherwise fails later, as `undefined is not a
   * constructor`, far from the file at fault.
   */
  async importDefault<T = unknown>(importFn: () => Promise<unknown>, label?: string): Promise<T> {
    const module = await importFn()
    if (module === null || typeof module !== 'object' || !('default' in module)) {
      throw new Error(
        `Missing default export${label ? ` in "${label}"` : ''}. ` +
          'Export the value as `export default`, or import the named export directly.',
      )
    }
    // The caller declares what it expects to find, the same contract as
    // `container.make<T>()` over a dynamic import.
    return module.default as T
  }

  /** The app's `package.json`, read once and cached; `undefined` when absent. */
  #packageJson(): { name?: string; version?: string } | undefined {
    if (this.#packageJsonRead) return this.#packageJsonCache
    this.#packageJsonRead = true
    try {
      const path = this.makePath('package.json')
      const raw = readFileSync(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        const name = 'name' in parsed && typeof parsed.name === 'string' ? parsed.name : undefined
        const version =
          'version' in parsed && typeof parsed.version === 'string' ? parsed.version : undefined
        this.#packageJsonCache = { name, version }
      }
    } catch {
      // No app root, no package.json, unreadable, or malformed — every one of
      // those means "we do not know the name", not "fail to boot".
      this.#packageJsonCache = undefined
    }
    return this.#packageJsonCache
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
    this.#providers.push(provider)
    if (typeof provider.register === 'function') {
      provider.register()
    }
  }

  /** Boot all registered providers. Runs booting/booted hooks. */
  async boot(): Promise<void> {
    if (this.#booted) return

    // Run booting hooks
    for (const hook of this.#bootingHooks) {
      await hook()
    }

    // Boot providers. `callProviderPhase` skips providers that don't
    // declare the phase — duck-typed packages (spectrum, warden, etc.)
    // implement only what they need.
    for (const provider of this.#providers) {
      await callProviderPhase(provider, 'boot')
    }

    this.#booted = true
    this.#state = 'booted'

    // Run booted hooks
    for (const hook of this.#bootedHooks) {
      await hook()
    }
  }

  /**
   * Mark the application ready — the LAST thing that happens, after the
   * providers' `ready()` hooks and after the HTTP server is accepting
   * connections.
   *
   * Not at the end of `boot()`: booting is when providers are wired, not when
   * the application can serve. A health check that reads `ready` there greens
   * a process with no listening socket, and a rolling deploy shifts traffic
   * onto it. Upstream sets its own `ready` state at the same point, after the
   * start callback and the ready hooks.
   */
  markReady(): void {
    this.#state = 'ready'
  }

  /**
   * Shutdown all providers in reverse order. Each hook/provider shutdown is
   * isolated: one throwing provider must not prevent the remaining providers
   * from closing their resources (DB pools, queues). Errors are aggregated.
   */
  async shutdown(): Promise<void> {
    const errors: unknown[] = []
    this.#state = 'terminating'

    for (const hook of this.#shutdownHooks) {
      try {
        await hook()
      } catch (err) {
        errors.push(err)
      }
    }

    for (const provider of [...this.#providers].reverse()) {
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

    this.#booted = false
    // Terminated even when a hook threw: the hooks and providers have all been
    // given their turn, so the application IS down. Reporting anything else
    // would leave a supervisor waiting on a shutdown that already happened.
    this.#state = 'terminated'
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Application.shutdown() completed with errors')
    }
  }

  /** Register a shutdown hook. */
  onShutdown(callback: () => Promise<void> | void): void {
    this.#shutdownHooks.push(callback)
  }

  get isBooted(): boolean {
    return this.#booted
  }

  get providerCount(): number {
    return this.#providers.length
  }
}

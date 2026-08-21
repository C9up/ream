/**
 * Ignitor — AdonisJS-compatible application bootstrap.
 *
 * Usage (like AdonisJS):
 *   new Ignitor(APP_ROOT, { importer: IMPORTER })
 *     .tap((app) => {
 *       app.booting(async () => { await import('#start/env') })
 *       app.listen('SIGTERM', () => app.terminate())
 *     })
 *     .httpServer()
 *     .start()
 *
 * @implements FR17, FR20, FR23
 */

import { Application } from './Application.js'
import type { Console } from './console/Console.js'
import type { CommandLoader, Kernel as ConsoleKernelInstance } from './console/Kernel.js'
import { type CommandClass, isCommandClass } from './console/types.js'
import type { ErrorEvent } from './ErrorBoundary.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { loadEnvFiles } from './env/loadEnvFiles.js'
import { prettyPrintError } from './errors/prettyPrintError.js'
import { ReamError } from './errors/ReamError.js'
import type { Emitter } from './events/Emitter.js'
import type { ShutdownHandle } from './GracefulShutdown.js'
import { installGracefulShutdown } from './GracefulShutdown.js'
import { startHotReload } from './HotReload.js'
import type { HttpKernelRequest, HttpKernelResponse } from './HttpKernel.js'
import { createHttpKernel } from './HttpKernel.js'
import { ExceptionHandler } from './http/Exception.js'
import type { MiddlewareFunction } from './middleware/Pipeline.js'
import { MiddlewareRegistry } from './middleware/Pipeline.js'
import type { AppContext, ProviderContract } from './Provider.js'
import { callProviderPhase } from './Provider.js'
import { Router } from './router/Router.js'
import { CookieSigner } from './security/CookieSigner.js'
import { SignedUrl } from './security/SignedUrl.js'
import { Server } from './server/Server.js'
import { clearApp, setApp } from './services/app.js'
import { clearRouter, setRouter } from './services/router.js'
import { clearServer, setServer } from './services/server.js'

/** Application environment. */
export type AppEnvironment = 'web' | 'console' | 'test' | 'unknown'

/**
 * Reamrc config — like AdonisJS adonisrc.ts with defineConfig().
 */
export interface ReamrcConfig {
  providers?: Array<
    | (() => Promise<{ default: new (app: AppContext) => ProviderContract }>)
    | {
        file: () => Promise<{ default: new (app: AppContext) => ProviderContract }>
        environment?: string[]
      }
  >
  preloads?: Array<
    | (() => Promise<unknown>)
    | {
        file: () => Promise<unknown>
        environment?: string[]
      }
  >
  commands?: Array<() => Promise<unknown>>
  /**
   * Command shorthands — Console's `commandsAliases`. The value is the command the
   * alias stands for, flags included:
   *   `{ resource: 'make:controller --resource' }`
   */
  commandsAliases?: Record<string, string>
  modules?: {
    /** Path to the modules directory (relative to app root). Default: './app/modules' */
    path?: string
    /** Auto-loaded files in each module directory. Default: ['routes'] */
    autoload?: string[]
  }
  /** Test suites and runner settings — the `tests` block of adonisrc.ts. */
  tests?: TestsConfig
}

/** One test suite, as declared in the rc file (AdonisJS `tests.suites[]`). */
export interface TestSuiteConfig {
  /** Suite name — what `ream test <name>` selects. */
  name: string
  /**
   * The suite's files: a glob, several, or a callback returning their URLs
   * (Japa `TestFiles`).
   */
  files: string | string[] | (() => URL[] | Promise<URL[]>)
  /** Per-test timeout for this suite, in ms. */
  timeout?: number
  /** Extra attempts on failure for this suite. */
  retries?: number
  /**
   * Configure the suite before it runs (Japa `TestSuite.configure`). Receives
   * the same handle as the bootstrap's `configureSuite`, and runs after it.
   *
   * Costs an import of the rc file in every worker, since a function cannot
   * cross a process boundary — `configureSuite` in `tests/bootstrap.ts` does
   * the same job for free, and is what AdonisJS itself uses.
   */
  configure?: (suite: TestSuiteHandle) => void
}

/**
 * What a suite's `configure` receives — helix's `SuiteHandle`, re-declared here
 * so the rc file types without ream depending on the runner at type level.
 */
export interface TestSuiteHandle {
  readonly name: string
  setup(fn: () => void | Promise<void>): TestSuiteHandle
  teardown(fn: () => void | Promise<void>): TestSuiteHandle
  onTest(callback: (test: unknown) => void): TestSuiteHandle
  onGroup(callback: (group: unknown) => void): TestSuiteHandle
  bail(toggle?: boolean): TestSuiteHandle
}

/**
 * The `tests` block of the rc file — AdonisJS `adonisrc.ts` `tests`, field for
 * field. The runner that consumes it is helix; ream reads the file, exactly as
 * `@adonisjs/core` reads adonisrc and hands the suites to Japa.
 */
export interface TestsConfig {
  /** Named suites. `ream test` with no argument runs them all, in order. */
  suites?: TestSuiteConfig[]
  /** Default per-test timeout, in ms. */
  timeout?: number
  /** `process.exit()` once the run ends instead of draining the event loop. */
  forceExit?: boolean
  /**
   * Ream particularity: the bootstrap module's path. AdonisJS hardcodes
   * `tests/bootstrap.ts`; that stays the default here, and this overrides it.
   */
  bootstrap?: string
  /**
   * Point `@japa/runner/core` at helix's shim in every worker, so official Japa
   * plugins (`@japa/assert`, …) instrument the runner that is actually running.
   *
   * Off by default: redirecting a package specifier is not something to do
   * behind a user's back, and a project with no Japa plugin gains nothing.
   */
  japaPlugins?: boolean
}

/** defineConfig helper — like AdonisJS defineConfig(). */
export function defineConfig(config: ReamrcConfig): ReamrcConfig {
  return config
}

/** Minimal interface for the HTTP server (NAPI or mock). */
export interface HyperServerLike {
  onRequest(callback: (request: HttpKernelRequest) => Promise<HttpKernelResponse>): void
  /**
   * Optional — present on the real `HyperServer` (Rust-backed), absent on
   * trivial test mocks. Ignitor only calls it when a shield config is set.
   */
  configureShield?(config: { pathTraversal: boolean; paramPollution: boolean }): void
  /** Optional — same lifecycle as `configureShield`. */
  configureTrustedProxies?(cidrs: string[]): void
  /** Optional — same lifecycle as `configureShield`. */
  configureRateLimit?(config: { max: number; windowSecs: number } | null): void
  listen(): Promise<void>
  port(): Promise<number>
  close(): Promise<void>
  // Streaming primitives — optional so mock servers (no NAPI) opt out
  // by simply not implementing them; the `response.sse()` helper throws
  // a clean `STREAMING_UNSUPPORTED` error when called on such a host.
  registerStream?(streamId: string): Promise<boolean>
  writeStream?(streamId: string, chunk: string): Promise<boolean>
  closeStream?(streamId: string): Promise<boolean>
  onStreamDisconnect?(streamId: string, callback: () => void): void
}

export interface IgnitorConfig {
  port?: number
  /**
   * Bind address of the HTTP server. Falls back to `process.env.HOST`, then to
   * `0.0.0.0` in production (a container has to accept traffic from outside its
   * own network namespace) and `localhost` everywhere else.
   */
  host?: string
  serverFactory?: (port: number, host: string) => HyperServerLike
  importer?: (filePath: string) => Promise<unknown>
  watchDirs?: string[]
  /**
   * Install SIGTERM/SIGINT handlers that drain the server on shutdown
   * (close the port, abort live SSE connections, shut providers down) instead
   * of letting the process be force-killed with in-flight work dropped. This is
   * what lets `ream dev` restart cleanly and an orchestrator's rolling deploy
   * finish in-flight requests. Web mode only. Default: `true`. Set `false` to
   * opt out (embedding hosts that manage their own signals, or test harnesses
   * that boot many Ignitors in one process).
   */
  gracefulShutdown?: boolean
}

/**
 * Ignitor — boots and wires the Ream framework.
 *
 * Lifecycle: register → boot → start → ready → shutdown
 */
export class Ignitor {
  private app: Application
  private router: Router
  private server: Server
  private middleware: MiddlewareRegistry
  private errorBoundary: ErrorBoundary
  private _httpServer?: HyperServerLike
  private config: IgnitorConfig
  private appRoot?: URL
  private environment: AppEnvironment = 'unknown'
  private reamrc?: ReamrcConfig
  private providers: ProviderContract[] = []
  private errorListeners: Array<(event: ErrorEvent) => void> = []
  private phase: 'created' | 'registered' | 'booted' | 'started' | 'ready' | 'shutdown' = 'created'
  private hotReloadCleanup?: () => void
  #shutdownHandle?: ShutdownHandle
  #host?: string
  #console?: Console

  // Inline configuration (for simple use or testing)
  private inlineRoutes?: (router: Router) => void
  private inlineMiddleware: MiddlewareFunction[] = []
  private inlineNamedMiddleware: Array<[string, MiddlewareFunction]> = []
  private inlineProviderFactories: Array<(app: Application) => ProviderContract> = []

  /**
   * Create the Ignitor.
   *
   * AdonisJS-style:
   *   new Ignitor(APP_ROOT, { importer: IMPORTER })
   *
   * Simple-style:
   *   new Ignitor({ port: 3000, serverFactory: ... })
   */
  constructor(appRootOrConfig?: URL | IgnitorConfig, config?: IgnitorConfig) {
    if (appRootOrConfig instanceof URL) {
      this.appRoot = appRootOrConfig
      this.config = config ?? {}
    } else {
      this.config = appRootOrConfig ?? {}
    }

    this.app = new Application()
    this.router = new Router()
    this.server = new Server(this.router)
    this.middleware = new MiddlewareRegistry()
    this.errorBoundary = new ErrorBoundary((event) => this.handleError(event), this.isDevMode())

    // Register framework services in container
    this.app.container.singleton('router', () => this.router)
    this.app.container.singleton('server', () => this.server)
    this.app.container.singleton('middleware', () => this.middleware)
    this.app.container.singleton('app', () => this.app)
    // `appRoot` is the URL passed to `new Ignitor(new URL('../', import.meta.url))`.
    // Providers resolve it through the container so they can interpret
    // relative paths in config files (e.g. `pages.root: './resources/pages'`)
    // against the project root — same convention `modules.path` uses.
    if (this.appRoot) {
      const root = this.appRoot
      this.app.container.singleton('appRoot', () => root)
      // Also expose it on the Application for the AdonisJS-style path helpers
      // (`app.makePath`, `app.configPath`, `app.migrationsPath`, …).
      this.app.setAppRoot(root)
    }

    // Encryption / cookie-signing service (AdonisJS `APP_KEY` idiom). Registered
    // only when APP_KEY is set; HttpContext hands it to Response/Request so
    // `cookie()` can sign, `encryptedCookie()` can encrypt and `request.cookie()`
    // can verify. Without APP_KEY, cookies stay plain (unsigned).
    const appKey = process.env.APP_KEY
    if (appKey) {
      if (appKey.length < 16) {
        throw new Error(
          'APP_KEY is too short — use at least a 16-character (ideally 32-byte) random key for cookie signing/encryption.',
        )
      }
      const signer = new CookieSigner(appKey)
      this.app.container.singleton('encryption', () => signer)
      // Signed-URL helper (same APP_KEY): the router signs via makeSignedUrl,
      // HttpContext hands it to the request so hasValidSignature() can verify.
      const signedUrl = new SignedUrl({ secret: appKey })
      this.app.container.singleton('signedUrl', () => signedUrl)
      this.router.setSignedUrl(signedUrl)
    }

    // Set service singletons so route/kernel files can import them
    setApp(this.app)
    setRouter(this.router)
    setServer(this.server)
  }

  // ─── Configuration ────────────────────────────────────────

  /**
   * Access the Application instance before start.
   * Like AdonisJS: .tap((app) => { app.booting(...) })
   */
  tap(callback: (app: Application) => void): this {
    callback(this.app)
    return this
  }

  /** Set the application environment. */
  setEnvironment(env: AppEnvironment): this {
    this.environment = env
    return this
  }

  getEnvironment(): AppEnvironment {
    return this.environment
  }

  /**
   * Load the reamrc config (equivalent to adonisrc.ts).
   */
  useRcFile(reamrc: ReamrcConfig): this {
    this.reamrc = reamrc
    return this
  }

  // === Inline configuration (simple mode / testing) ===

  /** Define routes inline (simple mode). */
  routes(callback: (router: Router) => void): this {
    this.inlineRoutes = callback
    return this
  }

  /** Add global middleware inline. */
  use(mw: MiddlewareFunction): this {
    this.inlineMiddleware.push(mw)
    return this
  }

  /** Register a named middleware inline. */
  named(name: string, mw: MiddlewareFunction): this {
    this.inlineNamedMiddleware.push([name, mw])
    return this
  }

  /** Register a provider inline (for testing or simple apps). */
  provider(factory: (app: Application) => ProviderContract): this {
    this.inlineProviderFactories.push(factory)
    return this
  }

  /** Listen for error events. */
  onError(listener: (event: ErrorEvent) => void): this {
    this.errorListeners.push(listener)
    return this
  }

  /** Set a config value. */
  configure(key: string, value: unknown): this {
    this.app.config.set(key, value)
    return this
  }

  // ─── Mode selection ───────────────────────────────────────

  /** Configure for HTTP server mode. */
  httpServer(): this {
    this.environment = 'web'
    return this
  }

  /** Configure for CLI/console mode. Returns a ConsoleKernel for dispatching commands. */
  console(): ConsoleKernel {
    this.environment = 'console'
    return new ConsoleKernel(this)
  }

  /** Configure for test mode. */
  testMode(): this {
    this.environment = 'test'
    return this
  }

  // ─── Lifecycle ────────────────────────────────────────────

  async start(): Promise<Ignitor> {
    // Double-start guard: a second start() would re-run phaseRegister and
    // instantiate + register every reamrc provider a second time.
    if (this.phase !== 'created') {
      throw new ReamError(
        'IGNITOR_ALREADY_STARTED',
        `start() called while in phase '${this.phase}' — an Ignitor boots once`,
        { hint: 'Create a new Ignitor instance instead of restarting this one.' },
      )
    }
    this.#loadEnvironmentFiles()
    try {
      await this.phaseRegister()
      await this.phaseBoot()
      await this.phaseStart()
      // Console documents its `consoleApp` service as available once the application has
      // booted, so the locator is installed here rather than on first use —
      // `import consoleApp from '@c9up/ream/services/console'` must not throw in a running
      // app. Only the façade is built (three small modules); loading the
      // commands themselves stays lazy, inside `consoleApp.boot()`.
      await this.consoleApp()
      await this.phaseReady()
    } catch (err) {
      // A throw mid-boot (e.g. a provider ready() failing AFTER the HTTP port
      // is bound) must release everything the partial boot opened — port,
      // scheduler tickers, watchers — or the process hangs with leaked
      // resources. Best-effort: the original boot error stays the one thrown.
      try {
        await this.stop()
      } catch {
        /* surface the boot error, not the rollback error */
      }
      throw err
    }
    return this
  }

  /**
   * Load `.env` files into `process.env` before config and providers boot —
   * mirroring AdonisJS, which loads env in BOTH the HTTP and the consoleApp (console)
   * flows. Without this, `ream migrate` and other console commands booted in a
   * clean subprocess never saw the `.env` the web server got from the shell.
   *
   * Uses Node's built-in parser (no dependency). Values already present in
   * `process.env` win, so the shell / CI always overrides the files.
   */
  #loadEnvironmentFiles(): void {
    if (!this.appRoot) return
    loadEnvFiles(this.appRoot, { skipEnvLocal: this.environment === 'test' })
  }

  private async phaseRegister(): Promise<void> {
    // Auto-load config/*.ts files into app.config
    await this.autoloadConfig()

    // Load providers from reamrc
    if (this.reamrc?.providers) {
      for (const providerEntry of this.reamrc.providers) {
        const providerImport =
          typeof providerEntry === 'function' ? providerEntry : providerEntry.file
        const env = typeof providerEntry === 'function' ? undefined : providerEntry.environment

        // Skip providers not matching current environment
        if (env && !env.includes(this.environment)) continue

        const mod = await providerImport()
        const ProviderClass = mod.default
        const instance = new ProviderClass(this.app)
        this.providers.push(instance)
        this.app.register(instance)
      }
    }

    // Register inline providers
    for (const factory of this.inlineProviderFactories) {
      const instance = factory(this.app)
      this.providers.push(instance)
      this.app.register(instance)
    }

    this.phase = 'registered'
  }

  private async phaseBoot(): Promise<void> {
    await this.app.boot()
    this.phase = 'booted'
  }

  private async phaseStart(): Promise<void> {
    // Import preload files (routes.ts, kernel.ts, etc.)
    if (this.reamrc?.preloads) {
      for (const preloadEntry of this.reamrc.preloads) {
        const preloadImport = typeof preloadEntry === 'function' ? preloadEntry : preloadEntry.file
        const env =
          typeof preloadEntry === 'function'
            ? undefined
            : (preloadEntry as { environment?: string[] }).environment

        if (env && !env.includes(this.environment)) continue
        await preloadImport()
      }
    }

    // Auto-load module files (routes.ts, etc.) from modules directory
    await this.autoloadModules()

    // Apply inline configuration
    for (const mw of this.inlineMiddleware) {
      this.middleware.use(mw)
    }
    for (const [name, mw] of this.inlineNamedMiddleware) {
      this.middleware.register(name, mw)
    }
    if (this.inlineRoutes) {
      this.inlineRoutes(this.router)
    }

    // Call start() on providers
    for (const provider of this.providers) {
      await callProviderPhase(provider, 'start')
    }

    this.phase = 'started'
  }

  private async phaseReady(): Promise<void> {
    // Boot the Server (resolves lazy error handler etc.)
    await this.server.boot()

    // Start HTTP server if in web mode
    if (this.environment === 'web' && this.config.serverFactory) {
      // Build the HttpKernel with server middleware + router middleware.
      // The streaming backend is resolved lazily — the HyperServer is
      // created a few lines down, after the kernel — so the kernel
      // closes over the `this._httpServer` slot and reads it on every
      // request through the factory.
      const kernel = createHttpKernel({
        router: this.router,
        middleware: this.middleware,
        container: this.app.container,
        exceptionHandler:
          this.server.getErrorHandler() ?? new ExceptionHandler(!this.app.inProduction),
        serverMiddleware: this.server.getServerMiddleware(),
        routerMiddleware: this.router.getRouterMiddleware(),
        onError: (error, ctx) => {
          this.errorBoundary.serviceError('HttpKernel', error, ctx.id)
        },
        streamBackend: () => {
          const server = this._httpServer
          if (
            server &&
            typeof server.registerStream === 'function' &&
            typeof server.writeStream === 'function' &&
            typeof server.closeStream === 'function' &&
            typeof server.onStreamDisconnect === 'function'
          ) {
            // Narrow to a backend-shaped record. All four methods are
            // present at this point — the check above guards mocked
            // servers without forcing a structural cast.
            return {
              registerStream: server.registerStream.bind(server),
              writeStream: server.writeStream.bind(server),
              closeStream: server.closeStream.bind(server),
              onStreamDisconnect: server.onStreamDisconnect.bind(server),
            }
          }
          return undefined
        },
      })

      const desiredPort = this.config.port ?? 3000
      // Port-scan fallback (+1..+19) is a DEV convenience only. In production
      // a silent drift to :3001 while the LB targets :3000 is an outage —
      // bind the configured port and let EADDRINUSE fail loudly. The probe
      // also has an inherent TOCTOU; acceptable in dev, not in prod.
      const availablePort = this.app.inProduction
        ? desiredPort
        : await findAvailablePort(desiredPort)
      this.#host =
        this.config.host ?? process.env.HOST ?? (this.app.inProduction ? '0.0.0.0' : 'localhost')
      this._httpServer = this.config.serverFactory(availablePort, this.#host)
      this._httpServer.onRequest(kernel)
      // Pre-resolve client IPs in Rust from the trusted-proxy CIDRs before
      // listen. Security filtering itself lives in @c9up/blackhole.
      const trustedProxies = this.server.getTrustedProxies()
      if (
        trustedProxies.length > 0 &&
        typeof this._httpServer.configureTrustedProxies === 'function'
      ) {
        this._httpServer.configureTrustedProxies([...trustedProxies])
      }
      await this._httpServer.listen()

      // Wire OS-signal graceful shutdown. Without it the process never closes
      // the HTTP server on SIGTERM/SIGINT, so live keep-alive / SSE sockets keep
      // the event loop alive — a `ream dev` restart or Ctrl+C ends in a watcher
      // force-kill, and an orchestrator's rolling deploy drops in-flight work.
      // onShutdown = this.stop(), which closes the port (aborting connections),
      // shuts providers down (DB pools), and releases the locators.
      if (this.config.gracefulShutdown !== false) {
        this.#shutdownHandle = installGracefulShutdown({
          onShutdown: () => this.stop(),
          logger: {
            info: (message) => this.#emitSystemInfo('GracefulShutdown', message, 'info'),
            error: (message) => this.#emitSystemInfo('GracefulShutdown', message, 'error'),
          },
        })
      }
    } else if (this.environment === 'web' && !this.config.serverFactory) {
      throw new ReamError(
        'IGNITOR_NO_SERVER_FACTORY',
        'httpServer() requires a serverFactory in config',
        {
          hint: 'Example: new Ignitor({ serverFactory: (port, host) => new HyperServer(port, host) })',
        },
      )
    }

    // Install error boundary
    this.errorBoundary.install()

    // Call ready() on providers
    for (const provider of this.providers) {
      await callProviderPhase(provider, 'ready')
    }

    // Core domain event: the app finished booting (all providers ready).
    // Emitted once through the bus when events are wired — zero hot-path cost.
    if (this.app.container.has('events')) {
      const bus = await this.app.container.resolve<Emitter>('events')
      bus.emit('app:ready', { environment: this.environment })
    }

    // Dev-mode change watcher. IMPORTANT: this does NOT attempt an in-process
    // reload. The previous implementation cleared the router + service registry
    // and re-invoked the reamrc preload thunks — but a dynamic import() of an
    // already-loaded ESM module returns the CACHED module without re-executing
    // its body (the thunk's specifier is opaque, so it cannot be cache-busted).
    // The "reload" therefore destroyed every preload-registered route on the
    // first file save and never restored them. Process-level restart is the
    // reload mechanism (`ream dev` runs `tsx watch`, which restarts on change);
    // this watcher only surfaces an informational event for hosts that embed
    // the Ignitor without a supervisor. A future true HMR needs a loader-hook
    // (hot-hook style) that can invalidate the ESM cache — plug it in here.
    if (this.isDevMode()) {
      const watchDirs = this.config.watchDirs ?? ['app', 'start']
      this.hotReloadCleanup = startHotReload({
        watchDirs,
        onReload: () => {
          this.handleError({
            type: 'system.info',
            source: 'HotReload',
            message:
              'File change detected — a process restart is required to apply it (`ream dev` restarts automatically).',
            severity: 'info',
            timestamp: new Date().toISOString(),
          } as ErrorEvent)
        },
        logger: {
          info: (msg) =>
            this.handleError({
              type: 'system.info',
              source: 'HotReload',
              message: msg,
              severity: 'info',
              timestamp: new Date().toISOString(),
            } as ErrorEvent),
        },
      })
    }

    this.phase = 'ready'
  }

  /**
   * Auto-load config/*.ts files into app.config store.
   * Each file's default export is stored under its filename (without extension).
   * e.g. config/database.ts → app.config.get('database')
   */
  private async autoloadConfig(): Promise<void> {
    const { readdirSync, existsSync } = await import('node:fs')
    const { join, basename } = await import('node:path')
    const { fileURLToPath, pathToFileURL } = await import('node:url')

    const configDir = this.appRoot
      ? join(fileURLToPath(this.appRoot), 'config')
      : join(process.cwd(), 'config')

    if (!existsSync(configDir)) return

    const files = readdirSync(configDir)
      .filter((f: string) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('.'))
      .sort()

    for (const file of files) {
      const key = basename(file).replace(/\.(ts|js)$/, '')
      const mod = await import(pathToFileURL(join(configDir, file)).href)
      this.app.config.set(key, mod.default ?? mod)
    }
  }

  /**
   * Auto-load module files (routes.ts, etc.) from the modules directory.
   * Scans modules.path for subdirectories and imports matching files.
   */
  private async autoloadModules(): Promise<void> {
    const modulesConfig = this.reamrc?.modules
    if (!modulesConfig?.path) return

    const { readdirSync, existsSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { pathToFileURL } = await import('node:url')

    // Resolve modules path relative to app root or cwd
    const basePath = this.appRoot
      ? join(fileURLToPath(this.appRoot), modulesConfig.path)
      : resolve(modulesConfig.path)

    if (!existsSync(basePath)) return

    const autoloadFiles = modulesConfig.autoload ?? ['routes', 'events']
    const moduleDirs = readdirSync(basePath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()

    for (const moduleDir of moduleDirs) {
      for (const fileName of autoloadFiles) {
        const tsPath = join(basePath, moduleDir, `${fileName}.ts`)
        const jsPath = join(basePath, moduleDir, `${fileName}.js`)
        const filePath = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null
        if (filePath) {
          await import(pathToFileURL(filePath).href)
        }
      }
    }
  }

  /**
   * Graceful shutdown. Every step runs even when an earlier one throws — a
   * failing `httpServer.close()` must not leave the error boundary installed,
   * providers un-shutdown (open DB pools), or the locators bound. Errors are
   * aggregated and rethrown at the end.
   */
  async stop(): Promise<void> {
    const errors: unknown[] = []

    // Release the consoleApp locator first — ownership-guarded, so a second Ignitor
    // having rebound it is left alone.
    if (this.#console !== undefined) {
      const consoleApp = this.#console
      this.#console = undefined
      try {
        const { clearConsole } = await import('./services/console.js')
        clearConsole(consoleApp)
      } catch {
        /* the module never loaded — nothing to clear */
      }
    }

    const attempt = async (step: () => void | Promise<void>): Promise<void> => {
      try {
        await step()
      } catch (err) {
        errors.push(err)
      }
    }

    // Remove the SIGTERM/SIGINT listeners first. On the signal path this is a
    // no-op (the handlers already fired); on a programmatic stop() it prevents
    // a leaked listener per Ignitor.
    await attempt(() => {
      this.#shutdownHandle?.cleanup()
      this.#shutdownHandle = undefined
    })
    await attempt(() => {
      if (this.hotReloadCleanup) this.hotReloadCleanup()
    })
    await attempt(async () => {
      if (this._httpServer) await this._httpServer.close()
    })
    await attempt(() => this.errorBoundary.uninstall())
    await attempt(() => this.app.shutdown())

    // Release the process-wide service locators (ownership-guarded): a stopped
    // app must not keep its container/router reachable through the module
    // singletons, and must not clobber a newer Ignitor's bindings.
    clearApp(this.app)
    clearRouter(this.router)
    clearServer(this.server)

    this.phase = 'shutdown'
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Ignitor.stop() completed with errors')
    }
  }

  // ─── Accessors ────────────────────────────────────────────

  async port(): Promise<number> {
    return this._httpServer ? this._httpServer.port() : 0
  }

  /**
   * The address the HTTP server was bound to. Resolved at start; undefined
   * before that (and in non-web environments). Use it in the boot banner —
   * printing a hardcoded `localhost` for a server bound to `0.0.0.0` sends
   * you looking in the wrong place.
   */
  host(): string | undefined {
    return this.#host
  }

  getApp(): Application {
    return this.app
  }

  /**
   * The application root passed to `new Ignitor(new URL('../', import.meta.url))`.
   * Undefined for inline/test ignitors created without one.
   */
  getAppRoot(): URL | undefined {
    return this.appRoot
  }

  /** Has the application already been started? */
  isStarted(): boolean {
    return this.phase === 'started' || this.phase === 'ready'
  }

  /**
   * The `consoleApp` façade — the programmatic console.
   *
   * Built on demand: the console modules are only imported when something
   * actually reaches for them, so an HTTP-only boot does not pay for the CLI.
   */
  async consoleApp(): Promise<Console> {
    if (this.#console !== undefined) return this.#console

    const [{ Console }, { setConsole }] = await Promise.all([
      import('./console/Console.js'),
      import('./services/console.js'),
    ])
    const { kernel, load } = await new ConsoleKernel(this).build()
    const consoleApp = new Console({ kernel, load })

    this.#console = consoleApp
    setConsole(consoleApp)
    this.app.container.singleton('console', () => consoleApp)
    return consoleApp
  }

  /** The loaded rc file, if `useRcFile()` was called. */
  getRcFile(): ReamrcConfig | undefined {
    return this.reamrc
  }

  /** The custom module importer, when the app provided one. */
  getImporter(): ((filePath: string) => Promise<unknown>) | undefined {
    return this.config.importer
  }

  getRouter(): Router {
    return this.router
  }

  getServer(): Server {
    return this.server
  }

  /**
   * Get the kernel callback (for serverless / testing). Memoized — building a
   * kernel per call would discard its compiled-pipeline cache every time.
   */
  getKernel(): (request: HttpKernelRequest) => Promise<HttpKernelResponse> {
    this.#kernel ??= createHttpKernel({
      router: this.router,
      middleware: this.middleware,
      container: this.app.container,
      exceptionHandler:
        this.server.getErrorHandler() ?? new ExceptionHandler(!this.app.inProduction),
      serverMiddleware: this.server.getServerMiddleware(),
      routerMiddleware: this.router.getRouterMiddleware(),
    })
    return this.#kernel
  }

  #kernel?: (request: HttpKernelRequest) => Promise<HttpKernelResponse>

  isDevMode(): boolean {
    return this.app.inDev
  }

  getPhase(): string {
    return this.phase
  }

  private handleError(event: ErrorEvent): void {
    for (const listener of this.errorListeners) {
      try {
        listener(event)
      } catch {
        /* Don't let listeners crash */
      }
    }
  }

  /**
   * Surface an informational/diagnostic message through the same channel as
   * HotReload — error listeners see it, nothing crashes. Used for the graceful
   * shutdown logger so drain progress / timeouts are observable.
   */
  #emitSystemInfo(source: string, message: string, kind: 'info' | 'error'): void {
    this.handleError({
      type: kind === 'error' ? 'system.error' : 'system.info',
      source,
      message,
      severity: kind === 'error' ? 'critical' : 'info',
      timestamp: new Date().toISOString(),
    } as ErrorEvent)
  }
}

export { prettyPrintError }

/**
 * ConsoleKernel — boots the app in console mode and dispatches a command.
 *
 * Console parity: `new Ignitor(...).console().handle(process.argv.slice(2))`.
 *
 * Commands come from two places, as in Console:
 *   1. the app's own `commands/` directory, discovered automatically;
 *   2. `reamrc.commands[]`, which registers commands shipped by packages.
 *
 * The application is booted lazily — only for a command declaring
 * `options.startApp`. A generator has no reason to open a database
 * connection, and paying the boot cost on every `--help` is worse than
 * pointless: it fails on a machine where the DB is simply not running.
 */
export class ConsoleKernel {
  #ignitor: Ignitor
  #started = false

  constructor(ignitor: Ignitor) {
    this.#ignitor = ignitor
  }

  /**
   * Build the console kernel and the function that fills it.
   *
   * Shared by `handle()` (the CLI) and the `consoleApp` façade (programmatic use), so
   * both see exactly the same commands — discovery plus `reamrc.commands` —
   * instead of two loaders drifting apart.
   */
  async build(): Promise<{ kernel: ConsoleKernelInstance; load: () => Promise<void> }> {
    const { Kernel } = await import('./console/Kernel.js')

    const kernel = new Kernel({
      binaryName: 'ream',
      // A `staysAlive` command ends itself through `this.terminate()`; the
      // kernel deliberately does not tear the app down for those.
      onTerminate: async () => {
        if (this.#started) await this.#ignitor.stop()
      },
      startApp: async () => {
        // The façade can be used from an already-running application; starting
        // it a second time would re-register providers.
        if (!this.#ignitor.isStarted()) {
          await this.#ignitor.start()
          this.#started = true
        }
        const app = this.#ignitor.getApp()
        app.container.singleton('consoleKernel', () => kernel)
        return app
      },
    })

    // Discovery is registered as a LOADER, not run beside the kernel: `boot()`
    // is then the single moment commands come in, whether they were found on
    // disk, declared in the rc file, or added by an application's own loader.
    kernel.addLoader(this.#commandLoader(kernel))

    const load = async (): Promise<void> => {
      const aliases = this.#ignitor.getRcFile()?.commandsAliases
      if (aliases !== undefined) {
        for (const [alias, expansion] of Object.entries(aliases)) {
          kernel.addAlias(alias, expansion)
        }
      }
      await kernel.boot()
    }

    return { kernel, load }
  }

  async handle(argv: string[]): Promise<void> {
    const { kernel, load } = await this.build()
    await load()

    let staysAlive = false
    try {
      // `process.execArgv` IS what node was started with — Console's `nodeArgs`,
      // which a command reads to know how the process was launched.
      const result = await kernel.handle(argv, process.execArgv)
      staysAlive = result.staysAlive
    } finally {
      // A throwing command must still release the Ignitor's resources
      // (scheduler tickers, watchers) — otherwise the CLI process hangs.
      // A `staysAlive` command keeps them on purpose.
      if (this.#started && !staysAlive) await this.#ignitor.stop()
    }
  }

  /**
   * The application's commands, as a loader the kernel consumes at boot.
   *
   * Two sources, one collection: the `commands/` directory and the rc file's
   * `commands[]`. Collecting them together is what lets a command listed in
   * both be reported as the duplicate it is.
   */
  #commandLoader(kernel: ConsoleCommandKernel): CommandLoader {
    const found = new Map<string, CommandClass>()

    return {
      getMetaData: async () => {
        await this.#discoverAppCommands(kernel, found)
        await this.#loadPackageCommands(found)
        // Imported here, not at the top of the file: the console stack is only
        // loaded for a console dispatch, and a static import would pull it into
        // every HTTP boot.
        const { serializeCommand } = await import('./console/Kernel.js')
        return [...found.values()].map(serializeCommand)
      },
      getCommand: async (metadata) => found.get(metadata.commandName) ?? null,
    }
  }

  /**
   * Load every command in the app's `commands/` directory.
   *
   * Tolerant by design: a module that does not default-export a command is
   * reported and skipped rather than aborting the whole CLI. Discovery scans a
   * conventional directory, so a stray helper file there must not make
   * `ream list` unusable. Explicitly declared entries (`reamrc.commands`) are
   * held to a stricter standard — see {@link #loadPackageCommands}.
   */
  async #discoverAppCommands(
    kernel: ConsoleCommandKernel,
    found: Map<string, CommandClass>,
  ): Promise<void> {
    const root = this.#ignitor.getAppRoot()
    if (root === undefined) return

    // The framework's own `FsLoader`, with the application's importer plugged
    // in: scanning a directory for commands is written once, and an app that
    // compiles its sources differently only replaces the import.
    const { FsLoader } = await import('./console/loaders.js')
    const importModule = (file: URL): Promise<unknown> => this.#importModule(file)

    const loader = new (class extends FsLoader {
      protected override import(file: URL): Promise<unknown> {
        return importModule(file)
      }
    })(new URL('commands/', root)).onSkipped((fileName) => {
      // Tolerant by design: discovery scans a conventional directory, so a
      // stray helper there must not make `ream list` unusable.
      kernel.logger.warning(`Skipped ${fileName} in commands/ — no default-exported command class.`)
    })

    for (const metadata of await loader.getMetaData()) {
      const command = await loader.getCommand(metadata)
      if (command !== null) found.set(command.commandName, command)
    }
  }

  /**
   * Register commands declared in `reamrc.commands[]` — the channel for
   * commands shipped by packages, which discovery cannot see.
   *
   * Strict: an entry listed by hand that does not resolve to a command is a
   * configuration error, and silently ignoring it is how a command "disappears"
   * with no explanation.
   */
  async #loadPackageCommands(found: Map<string, CommandClass>): Promise<void> {
    const declared = this.#ignitor.getRcFile()?.commands
    if (!declared) return

    for (const entry of declared) {
      const command = commandOf(await entry())
      if (command === undefined) {
        throw new ReamError(
          'E_CONSOLE_INVALID_COMMAND',
          'An entry of reamrc.ts `commands` does not default-export a command class.',
          {
            hint: 'Expected `export default class X { static commandName = "..."; static description = "..."; run() {} }`.',
          },
        )
      }

      // The most likely duplicate after the move to auto-discovery: a command
      // living in `commands/` AND still listed by hand. Say so, rather than
      // leaving the user to guess which two registrations collided.
      const existing = found.get(command.commandName)
      if (existing !== undefined && existing !== command) {
        throw new ReamError(
          'E_CONSOLE_DUPLICATE_COMMAND',
          `Two commands claim the name "${command.commandName}".`,
          {
            hint: 'Commands in commands/ are discovered automatically — remove this entry from reamrc.ts `commands`, which is only for commands shipped by packages.',
          },
        )
      }
      found.set(command.commandName, command)
    }
  }

  /** Honour the app's custom importer when it provided one. */
  async #importModule(file: URL): Promise<unknown> {
    const importer = this.#ignitor.getImporter()
    if (importer === undefined) return import(file.href)

    const root = this.#ignitor.getAppRoot()
    const relative = root === undefined ? file.href : `./${file.href.slice(root.href.length)}`
    return importer(relative)
  }
}

/** The slice of the console kernel this class drives. */
interface ConsoleCommandKernel {
  addAlias(alias: string, expansion: string): unknown
  logger: { warning(message: string): void }
}

/** The command a module default-exports, or undefined when it exports none. */
function commandOf(mod: unknown): CommandClass | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined
  const value = Reflect.get(mod, 'default')
  return isCommandClass(value) ? value : undefined
}

async function findAvailablePort(desired: number): Promise<number> {
  const net = await import('node:net')
  for (let port = desired; port < desired + 20; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.listen(port, () => server.close(() => resolve(true)))
      server.on('error', () => resolve(false))
    })
    if (available) return port
  }
  return desired
}

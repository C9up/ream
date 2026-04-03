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
import { createHttpKernel } from './HttpKernel.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { ExceptionHandler } from './http/Exception.js'
import { ReamError } from './errors/ReamError.js'
import type { ErrorEvent } from './ErrorBoundary.js'
import { startHotReload } from './HotReload.js'
import { MiddlewareRegistry } from './middleware/Pipeline.js'
import type { MiddlewareFunction } from './middleware/Pipeline.js'
import type { Provider, AppContext } from './Provider.js'
import { Router } from './router/Router.js'
import { Server } from './server/Server.js'
import { _setApp } from './services/app.js'
import { _setRouter } from './services/router.js'
import { _setServer } from './services/server.js'

/** Application environment. */
export type AppEnvironment = 'web' | 'console' | 'test' | 'unknown'

/**
 * Reamrc config — like AdonisJS adonisrc.ts with defineConfig().
 */
export interface ReamrcConfig {
  providers?: Array<(() => Promise<{ default: new (app: AppContext) => Provider }>) | {
    file: () => Promise<{ default: new (app: AppContext) => Provider }>
    environment?: string[]
  }>
  preloads?: Array<(() => Promise<unknown>) | {
    file: () => Promise<unknown>
    environment?: string[]
  }>
  commands?: Array<() => Promise<unknown>>
  modules?: {
    /** Path to the modules directory (relative to app root). Default: './app/modules' */
    path?: string
    /** Auto-loaded files in each module directory. Default: ['routes'] */
    autoload?: string[]
  }
  tests?: {
    suites?: Array<{ name: string; files: string[]; timeout?: number }>
    forceExit?: boolean
  }
}

/** defineConfig helper — like AdonisJS defineConfig(). */
export function defineConfig(config: ReamrcConfig): ReamrcConfig {
  return config
}

/** Minimal interface for the HTTP server (NAPI or mock). */
export interface HyperServerLike {
  onRequest(callback: (requestJson: string) => Promise<string>): void
  listen(): Promise<void>
  port(): Promise<number>
  close(): Promise<void>
}

export interface IgnitorConfig {
  port?: number
  serverFactory?: (port: number) => HyperServerLike
  importer?: (filePath: string) => Promise<unknown>
  watchDirs?: string[]
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
  private providers: Provider[] = []
  private errorListeners: Array<(event: ErrorEvent) => void> = []
  private phase: 'created' | 'registered' | 'booted' | 'started' | 'ready' | 'shutdown' = 'created'
  private hotReloadCleanup?: () => void

  // Inline configuration (for simple use or testing)
  private inlineRoutes?: (router: Router) => void
  private inlineMiddleware: MiddlewareFunction[] = []
  private inlineNamedMiddleware: Array<[string, MiddlewareFunction]> = []
  private inlineProviderFactories: Array<(app: Application) => Provider> = []

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
    this.errorBoundary = new ErrorBoundary(
      (event) => this.handleError(event),
      this.isDevMode(),
    )

    // Register framework services in container
    this.app.container.singleton('router', () => this.router)
    this.app.container.singleton('server', () => this.server)
    this.app.container.singleton('middleware', () => this.middleware)
    this.app.container.singleton('app', () => this.app)

    // Set service singletons so route/kernel files can import them
    _setApp(this.app)
    _setRouter(this.router)
    _setServer(this.server)
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
  provider(factory: (app: Application) => Provider): this {
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

  /** Configure for CLI/console mode (future). */
  console(): this {
    this.environment = 'console'
    return this
  }

  /** Configure for test mode. */
  testMode(): this {
    this.environment = 'test'
    return this
  }

  // ─── Lifecycle ────────────────────────────────────────────

  async start(): Promise<Ignitor> {
    await this.phaseRegister()
    await this.phaseBoot()
    await this.phaseStart()
    await this.phaseReady()
    return this
  }

  private async phaseRegister(): Promise<void> {
    // Load providers from reamrc
    if (this.reamrc?.providers) {
      for (const providerEntry of this.reamrc.providers) {
        const providerImport = typeof providerEntry === 'function' ? providerEntry : providerEntry.file
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
        const env = typeof preloadEntry === 'function' ? undefined : (preloadEntry as { environment?: string[] }).environment

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
      if ('start' in provider && typeof (provider as { start: () => Promise<void> }).start === 'function') {
        await (provider as { start: () => Promise<void> }).start()
      }
    }

    this.phase = 'started'
  }

  private async phaseReady(): Promise<void> {
    // Boot the Server (resolves lazy error handler etc.)
    await this.server.boot()

    // Start HTTP server if in web mode
    if (this.environment === 'web' && this.config.serverFactory) {
      // Build the HttpKernel with server middleware + router middleware
      const kernel = createHttpKernel({
        router: this.router,
        middleware: this.middleware,
        container: this.app.container,
        exceptionHandler: this.server.getErrorHandler() ?? new ExceptionHandler(!this.app.inProduction),
        serverMiddleware: this.server.getServerMiddleware(),
        routerMiddleware: this.router.getRouterMiddleware(),
        onError: (error, ctx) => {
          this.errorBoundary.serviceError('HttpKernel', error, ctx.id)
        },
      })

      const desiredPort = this.config.port ?? 3000
      const availablePort = await findAvailablePort(desiredPort)
      this._httpServer = this.config.serverFactory(availablePort)
      this._httpServer.onRequest(kernel)
      await this._httpServer.listen()
    } else if (this.environment === 'web' && !this.config.serverFactory) {
      throw new ReamError('IGNITOR_NO_SERVER_FACTORY', 'httpServer() requires a serverFactory in config', {
        hint: 'Example: new Ignitor({ serverFactory: (port) => new HyperServer(port) })',
      })
    }

    // Install error boundary
    this.errorBoundary.install()

    // Call ready() on providers
    for (const provider of this.providers) {
      if ('ready' in provider && typeof (provider as { ready: () => Promise<void> }).ready === 'function') {
        await (provider as { ready: () => Promise<void> }).ready()
      }
    }

    // Hot-reload in dev mode
    if (this.isDevMode()) {
      const watchDirs = this.config.watchDirs ?? ['app', 'start']
      this.hotReloadCleanup = startHotReload({
        watchDirs,
        onReload: async () => {
          const { clearServiceRegistry } = await import('./decorators/Service.js')
          clearServiceRegistry()
          this.router.clear()
          if (this.inlineRoutes) this.inlineRoutes(this.router)
          if (this.reamrc?.preloads) {
            for (const preloadEntry of this.reamrc.preloads) {
              const preloadImport = typeof preloadEntry === 'function' ? preloadEntry : preloadEntry.file
              await preloadImport()
            }
          }
        },
        logger: { info: (msg) => this.handleError({ type: 'system.info', source: 'HotReload', message: msg, severity: 'info', timestamp: new Date().toISOString() } as ErrorEvent) },
      })
    }

    this.phase = 'ready'
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

    const autoloadFiles = modulesConfig.autoload ?? ['routes']
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

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    if (this.hotReloadCleanup) this.hotReloadCleanup()
    if (this._httpServer) await this._httpServer.close()
    this.errorBoundary.uninstall()
    await this.app.shutdown()
    this.phase = 'shutdown'
  }

  // ─── Accessors ────────────────────────────────────────────

  async port(): Promise<number> {
    return this._httpServer ? this._httpServer.port() : 0
  }

  getApp(): Application {
    return this.app
  }

  getRouter(): Router {
    return this.router
  }

  getServer(): Server {
    return this.server
  }

  /** Get the kernel callback (for serverless / testing). */
  getKernel(): (requestJson: string) => Promise<string> {
    return createHttpKernel({
      router: this.router,
      middleware: this.middleware,
      container: this.app.container,
      exceptionHandler: this.server.getErrorHandler() ?? new ExceptionHandler(!this.app.inProduction),
      serverMiddleware: this.server.getServerMiddleware(),
      routerMiddleware: this.router.getRouterMiddleware(),
    })
  }

  isDevMode(): boolean {
    return this.app.inDev
  }

  getPhase(): string {
    return this.phase
  }

  private handleError(event: ErrorEvent): void {
    for (const listener of this.errorListeners) {
      try { listener(event) } catch { /* Don't let listeners crash */ }
    }
  }
}

/**
 * Pretty-print an error (like AdonisJS prettyPrintError).
 */
export function prettyPrintError(error: unknown): void {
  if (error instanceof ReamError) {
    console.error(error.toDevString())
  } else if (error instanceof Error) {
    console.error(`\n  ${error.message}\n`)
    if (error.stack) console.error(error.stack)
  } else {
    console.error(error)
  }
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

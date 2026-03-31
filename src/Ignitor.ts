/**
 * Ignitor — Application bootstrap following AdonisJS conventions.
 *
 * Lifecycle: init → register → boot → start → ready → (running) → shutdown
 *
 * Convention:
 *   bin/server.ts           — entry point
 *   reamrc.ts               — manifest (providers, preloads)
 *   start/routes.ts         — route definitions
 *   start/kernel.ts         — middleware registration
 *   config/*.ts             — per-module configuration
 *
 * Usage:
 *   // bin/server.ts
 *   import { Ignitor } from '@c9up/ream'
 *   new Ignitor(new URL('../', import.meta.url))
 *     .httpServer()
 *     .start()
 *
 * @implements FR17, FR20, FR23
 */

import { Application } from './Application.js'
import { createHttpKernel } from './HttpKernel.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import type { ErrorEvent } from './ErrorBoundary.js'
import { startHotReload } from './HotReload.js'
import { MiddlewareRegistry } from './middleware/Pipeline.js'
import type { MiddlewareFunction } from './middleware/Pipeline.js'
import type { Provider, AppContext } from './Provider.js'
import { Router } from './router/Router.js'

/** Application environment. */
export type AppEnvironment = 'web' | 'console' | 'test' | 'unknown'

/** Reamrc manifest structure (mirrors AdonisJS adonisrc.ts). */
export interface ReamrcConfig {
  /** Service providers — lazy-loaded via dynamic import. */
  providers?: Array<() => Promise<{ default: new (app: AppContext) => Provider }>>

  /** Preload files — imported during the start phase (routes, kernel, etc.). */
  preloads?: Array<() => Promise<unknown>>

  /** CLI commands (future). */
  commands?: Array<() => Promise<unknown>>
}

/** Minimal interface for the HTTP server (NAPI or mock). */
export interface HyperServerLike {
  onRequest(callback: (requestJson: string) => Promise<string>): void
  listen(): Promise<void>
  port(): Promise<number>
  close(): Promise<void>
}

export interface IgnitorConfig {
  /** HTTP port (default: 3000, 0 for random) */
  port?: number
  /** Custom server factory */
  serverFactory?: (port: number) => HyperServerLike
  /** Directories to watch for hot-reload in dev mode (default: ['app', 'start']) */
  watchDirs?: string[]
}

/**
 * Ignitor — boots and wires the Ream framework.
 *
 * Follows AdonisJS lifecycle:
 * 1. init — create Application, Router, Pipeline
 * 2. register — load providers, call register()
 * 3. boot — call boot() on all providers
 * 4. start — import preload files (routes, kernel), call start() on providers
 * 5. ready — start HTTP server, call ready() on providers
 * 6. shutdown — reverse order cleanup
 */
export class Ignitor {
  private app: Application
  private router: Router
  private middleware: MiddlewareRegistry
  private errorBoundary: ErrorBoundary
  private server?: HyperServerLike
  private config: IgnitorConfig
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

  constructor(config: IgnitorConfig = {}) {
    this.config = config
    this.app = new Application()
    this.router = new Router()
    this.middleware = new MiddlewareRegistry()
    this.errorBoundary = new ErrorBoundary(
      (event) => this.handleError(event),
      this.isDevMode(),
    )

    // Register framework services in container
    this.app.container.singleton('router', () => this.router)
    this.app.container.singleton('middleware', () => this.middleware)
  }

  /**
   * Set the application environment.
   */
  setEnvironment(env: AppEnvironment): this {
    this.environment = env
    return this
  }

  /**
   * Get the application environment.
   */
  getEnvironment(): AppEnvironment {
    return this.environment
  }

  /**
   * Load the reamrc manifest (equivalent to AdonisJS adonisrc.ts).
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

  // === Lifecycle methods ===

  /**
   * Configure for HTTP server mode and start.
   * Equivalent to AdonisJS: new Ignitor(url).httpServer().start()
   */
  httpServer(): this {
    this.environment = 'web'
    return this
  }

  /**
   * Configure for CLI/console mode (future).
   */
  console(): this {
    this.environment = 'console'
    return this
  }

  /**
   * Configure for test mode.
   */
  testMode(): this {
    this.environment = 'test'
    return this
  }

  /**
   * Start the application through the full lifecycle.
   *
   * Phase 1 — REGISTER: Load and register all providers
   * Phase 2 — BOOT: Boot all providers
   * Phase 3 — START: Import preloads, apply inline config, providers start()
   * Phase 4 — READY: Start HTTP server (if web), providers ready()
   */
  async start(): Promise<Ignitor> {
    // === Phase 1: REGISTER ===
    await this.phaseRegister()

    // === Phase 2: BOOT ===
    await this.phaseBoot()

    // === Phase 3: START ===
    await this.phaseStart()

    // === Phase 4: READY ===
    await this.phaseReady()

    return this
  }

  private async phaseRegister(): Promise<void> {
    // Load providers from reamrc
    if (this.reamrc?.providers) {
      for (const providerImport of this.reamrc.providers) {
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
      for (const preloadImport of this.reamrc.preloads) {
        await preloadImport()
      }
    }

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

    // Call start() on providers that have it
    for (const provider of this.providers) {
      if ('start' in provider && typeof (provider as { start: () => Promise<void> }).start === 'function') {
        await (provider as { start: () => Promise<void> }).start()
      }
    }

    this.phase = 'started'
  }

  private async phaseReady(): Promise<void> {
    // Start HTTP server if in web mode
    if (this.environment === 'web' && this.config.serverFactory) {
      const kernel = createHttpKernel({
        router: this.router,
        middleware: this.middleware,
        onError: (error, ctx) => {
          this.errorBoundary.serviceError('HttpKernel', error, ctx.id)
        },
      })

      const desiredPort = this.config.port ?? 3000
      const availablePort = await findAvailablePort(desiredPort)
      this.server = this.config.serverFactory(availablePort)
      this.server.onRequest(kernel)
      await this.server.listen()
    }

    // Install error boundary
    this.errorBoundary.install()

    // Call ready() on providers that have it
    for (const provider of this.providers) {
      if ('ready' in provider && typeof (provider as { ready: () => Promise<void> }).ready === 'function') {
        await (provider as { ready: () => Promise<void> }).ready()
      }
    }

    // Start hot-reload in dev mode — watch TS files and re-register routes/middleware
    if (this.isDevMode()) {
      const watchDirs = this.config.watchDirs ?? ['app', 'start']
      this.hotReloadCleanup = startHotReload({
        watchDirs,
        onReload: async () => {
          // Clear and re-register routes + middleware
          this.router.clear()
          if (this.inlineRoutes) this.inlineRoutes(this.router)
          // Re-import preload files with cache bust
          if (this.reamrc?.preloads) {
            for (const preloadImport of this.reamrc.preloads) {
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
   * Graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.hotReloadCleanup) this.hotReloadCleanup()
    if (this.server) {
      await this.server.close()
    }
    this.errorBoundary.uninstall()
    await this.app.shutdown()
    this.phase = 'shutdown'
  }

  // === Accessors ===

  /** Get the actual bound port (after start). */
  async port(): Promise<number> {
    return this.server ? this.server.port() : 0
  }

  /** Get the Application instance. */
  getApp(): Application {
    return this.app
  }

  /** Get the Router. */
  getRouter(): Router {
    return this.router
  }

  /** Get the kernel callback (for serverless / testing). */
  getKernel(): (requestJson: string) => Promise<string> {
    return createHttpKernel({
      router: this.router,
      middleware: this.middleware,
    })
  }

  /**
   * Check if running in dev mode.
   * Dev = not production and not test. Hot-reload only in dev.
   */
  isDevMode(): boolean {
    const env = process.env.NODE_ENV
    return env !== 'production' && env !== 'test'
  }

  /** Get current lifecycle phase. */
  getPhase(): string {
    return this.phase
  }

  private handleError(event: ErrorEvent): void {
    for (const listener of this.errorListeners) {
      try {
        listener(event)
      } catch { /* Don't let listeners crash */ }
    }
  }
}

/**
 * Find an available port starting from the desired port.
 * If the port is taken, tries the next one (up to 20 attempts).
 */
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
  return desired // fallback — let the server error naturally
}

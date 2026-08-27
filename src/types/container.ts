/**
 * The container's known bindings, as a type.
 *
 * Resolving from the container is a string lookup, so without a shared
 * interface every `container.make('router')` returns `unknown` and every app
 * casts. AdonisJS solves it with an augmentable `ContainerBindings`, and every
 * package in its ecosystem adds its own token to it:
 *
 * ```ts
 * declare module '@c9up/ream/types' {
 *   interface ContainerBindings {
 *     auth: AuthManager
 *   }
 * }
 * ```
 *
 * Ream core registers the entries below; anything else — `auth` (warden),
 * `logger` (spectrum), `db` (atlas) — reaches this interface by augmentation
 * from the package that owns it, which is why the interface is open rather
 * than a closed union.
 */

import type { Application } from '../Application.js'
import type { ConfigStore } from '../ConfigLoader.js'
import type { Console } from '../console/Console.js'
import type { Kernel } from '../console/Kernel.js'
import type { Emitter } from '../events/Emitter.js'
import type { HttpContext } from '../http/HttpContext.js'
import type { MiddlewareRegistry } from '../middleware/Pipeline.js'
import type { MigrationRegistry } from '../migrations/MigrationRegistry.js'
import type { Router } from '../router/Router.js'
import type { CookieSigner } from '../security/CookieSigner.js'
import type { SignedUrl } from '../security/SignedUrl.js'
import type { Server } from '../server/Server.js'

export interface ContainerBindings {
  /** The application instance. */
  app: Application
  /** Absolute path to the application root. */
  appRoot: string
  /** The config store built from `config/*.ts`. */
  config: ConfigStore
  /** The console application (AdonisJS calls its equivalent `ace`). */
  console: Console
  /** The console kernel that dispatches commands. */
  consoleKernel: Kernel
  /** The event emitter. */
  emitter: Emitter
  /** Cookie/value signing and encryption, backed by `APP_KEY`. */
  encryption: CookieSigner
  /** The `HttpContext` class itself — for `HttpContext.getOrFail()` style access. */
  HttpContext: typeof HttpContext
  /** Named middleware registered by the app kernel. */
  middleware: MiddlewareRegistry
  /** Migration sources contributed by data packages (atlas, eon, ...). */
  migrations: MigrationRegistry
  /** The HTTP router. */
  router: Router
  /** The HTTP server. */
  server: Server
  /** Signed-URL generation and verification. */
  signedUrl: SignedUrl
}

/** A token this container knows how to resolve. */
export type ContainerBinding = keyof ContainerBindings

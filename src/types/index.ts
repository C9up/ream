/**
 * The interfaces an application or a package augments — `@c9up/ream/types`.
 *
 * Resolving from the container and picking an auth guard are both string
 * lookups; without a shared interface to augment, every call site casts.
 *
 * The augmentable interfaces are DECLARED here rather than re-exported from a
 * neighbouring file, and that is load-bearing: TypeScript augments the module
 * that declares an interface, so a re-export makes
 * `declare module '@c9up/ream/types' { interface Authenticators { … } }` a
 * duplicate declaration instead of an augmentation. warden hit exactly that.
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

/**
 * Guard name → what `auth.use(name)` hands back.
 *
 * Empty here, and deliberately: ream owns no auth package, so it cannot know
 * the guards an app configured. The auth package fills it in:
 *
 * ```ts
 * declare module '@c9up/ream/types' {
 *   interface Authenticators {
 *     session: SessionGuard
 *   }
 * }
 * ```
 *
 * Until something augments it, `keyof Authenticators` is `never` and `use()`
 * falls through to its `unknown` signature — the previous behaviour kept as
 * the floor rather than the ceiling.
 */
/**
 * An EMPTY INTERFACE is the whole mechanism here, not an oversight. Rewritten
 * as `type Authenticators = {}` the declaration stops being augmentable:
 * `declare module '@c9up/ream/types' { interface Authenticators { … } }`
 * becomes a duplicate identifier instead of a merge, and warden cannot type
 * `ctx.auth.use()`. That is exactly what shipped in 0.2.3, where the formatter
 * had rewritten it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: it must stay an interface to be augmentable — see above
export interface Authenticators {}

/** A guard name this application knows about. */
export type AuthenticatorName = keyof Authenticators

/**
 * The container's known bindings.
 *
 * Ream core registers the entries below; anything else — `auth` (warden),
 * `logger` (spectrum), `db` (atlas) — reaches this interface by augmentation
 * from the package that owns it, which is why it is open rather than a closed
 * union.
 */
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

/**
 * Default HyperServer factory — encapsulates the platform-suffix mapping
 * and the require() lookup so consumer apps stop hand-rolling the same
 * ~25 lines in every `bin/server.ts`.
 *
 * Usage in an app:
 *
 *     import { createHyperServerFactory } from '@c9up/ream/bootstrap'
 *     new Ignitor(APP_ROOT, {
 *       port: 3000,
 *       serverFactory: createHyperServerFactory(),
 *     })
 *
 * The binary is `index.<platform>.node`, found by the shared loader: at the
 * package root in a checkout, otherwise in the platform package
 * `@c9up/ream-<platform>` that ream installs as an optional dependency.
 *
 * There is no JavaScript HTTP server to fall back to, so a binary that is
 * missing, unloadable or not the HTTP server stops the app here with the
 * loader's coded error, rather than surfacing later as an app with no server.
 */

import { E_REAM_NAPI_LOAD_FAILED } from '../errors/codes.js'
import { loadNapi } from '../helpers/napi-loader.js'
import type { HyperServerLike } from '../Ignitor.js'

interface HyperServerCtor {
  new (port: number, host?: string): HyperServerLike
}

interface HyperServerNapiModule {
  HyperServer: HyperServerCtor
}

function isHyperServerNapi(value: unknown): value is HyperServerNapiModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'HyperServer' in value &&
    typeof value.HyperServer === 'function'
  )
}

/**
 * Resolve the prebuilt HyperServer NAPI binary for the current platform and
 * return a `serverFactory` compatible with `IgnitorConfig`.
 *
 * Throws `E_REAM_NAPI_UNSUPPORTED_PLATFORM` on a host no binary is built for,
 * `E_REAM_NAPI_NOT_FOUND` when the binary is nowhere (its `help` names the
 * platform package to install), and `E_REAM_NAPI_LOAD_FAILED` when it is there
 * but does not load or does not export the HTTP server.
 */
export function createHyperServerFactory(): (port: number, host?: string) => HyperServerLike {
  const mod = loadNapi<unknown>({ binaryName: 'index', callerMetaUrl: import.meta.url })
  if (!isHyperServerNapi(mod)) {
    throw new E_REAM_NAPI_LOAD_FAILED([
      'index',
      'index.<platform>.node',
      'it exports no HyperServer class, so it is not the HTTP server ream builds: rebuild it (pnpm --filter @c9up/ream build:napi) or reinstall @c9up/ream.',
    ])
  }

  const Ctor = mod.HyperServer
  return (port: number, host?: string) => new Ctor(port, host)
}

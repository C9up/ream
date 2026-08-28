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
 *       serverFactory: await createHyperServerFactory(),
 *     })
 *
 * Returns `undefined` when no prebuilt binary matches the host platform —
 * callers can branch on that to fall back to a JS-only server in tests.
 *
 * Binary lives at the package root (`./index.<platform>.node`),
 * matching the @c9up/chronos / @c9up/sigil convention.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'
import { NAPI_PLATFORM_MAP } from '../helpers/napi-loader.js'
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
 * Resolve the prebuilt HyperServer NAPI binary for the current platform.
 * Returns a `serverFactory` compatible with `IgnitorConfig`, or `undefined`
 * when no binary is available (unsupported platform / missing build).
 */
export function createHyperServerFactory():
  | ((port: number, host?: string) => HyperServerLike)
  | undefined {
  const suffix = NAPI_PLATFORM_MAP[`${platform}-${arch}`]
  if (!suffix) return undefined

  const require2 = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  // bootstrap/hyper-server.ts lives at src/bootstrap/, so the package root
  // is two directories up.
  const binaryPath = join(here, '..', '..', `index.${suffix}.node`)

  let mod: unknown
  try {
    mod = require2(binaryPath)
  } catch {
    return undefined
  }

  if (!isHyperServerNapi(mod)) return undefined

  const Ctor = mod.HyperServer
  return (port: number, host?: string) => new Ctor(port, host)
}

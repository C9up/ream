/**
 * Shared NAPI binary loader. Every `.node` file distributed with
 * `@c9up/ream` uses the same platform-suffix convention and lookup
 * strategy — extracting this helper avoids drift between the call sites
 * (HyperServer, GraphQL, Scheduler, event bus).
 *
 * A checkout builds the binaries at the package root (`pnpm build:napi`). A
 * published `@c9up/ream` carries none: each platform's three binaries ship in
 * their own npm package, `@c9up/ream-<suffix>`, an optional dependency pinned
 * to ream's exact version, and the package manager installs the one matching
 * the host.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  E_REAM_NAPI_LOAD_FAILED,
  E_REAM_NAPI_NOT_FOUND,
  E_REAM_NAPI_UNSUPPORTED_PLATFORM,
} from '../errors/codes.js'
import { errorCode } from './errors.js'

/**
 * Platform triple suffix (matches napi-rs naming).
 *
 * The ONE map for `@c9up/ream`. Every native package carries its own — they are
 * independently publishable and must not import each other — so a new target
 * still has to be added per package; within ream it is added here once.
 *
 * Linux binaries target GLIBC. musl (Alpine) is not a supported target, and the
 * loader says so rather than reporting a bare "not found".
 */
const NAPI_PLATFORM_MAP: Record<string, string> = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

/**
 * The npm package that carries the binaries of the platform `suffix`, an
 * optional dependency of `@c9up/ream` pinned to its exact version.
 */
function napiPlatformPackage(suffix: string): string {
  return `@c9up/ream-${suffix}`
}

export interface LoadNapiOptions {
  /**
   * Base filename of the `.node` binary (without the platform suffix
   * or `.node` extension). E.g. `"index"` for HyperServer,
   * `"scheduler"` for the Ream scheduler.
   */
  binaryName: string
  /**
   * Caller's `import.meta.url` — used to compute the candidate paths
   * relative to the caller's module location.
   */
  callerMetaUrl: string
  /**
   * What a checkout should do about a missing binary (typically a build
   * command), in place of `pnpm build:napi` at the end of the "not found"
   * error's `help`, after the platform package to install.
   */
  notFoundHint?: string
}

/**
 * Resolve and `require` a Ream NAPI binary, returning the native
 * module export. Throws `E_REAM_NAPI_UNSUPPORTED_PLATFORM`,
 * `E_REAM_NAPI_LOAD_FAILED` or `E_REAM_NAPI_NOT_FOUND` on a failure.
 *
 * Search order (first hit wins):
 *   1. `<caller>/../../<binaryName>.<suffix>.node`
 *   2. `<caller>/../<binaryName>.<suffix>.node`
 *   3. `<caller>/<binaryName>.<suffix>.node`
 *   4. `@c9up/ream-<suffix>/<binaryName>.<suffix>.node`, the platform package
 *
 * The three local paths match the layout where the compiled `.node` sits
 * either at the package root, a subdirectory, or next to the calling module:
 * a checkout runs the Rust it just built. The platform package is asked for
 * only when none of them exists. A local file that exists but fails to load is
 * a broken build, reported as is rather than papered over by the package.
 */
export function loadNapi<T>(options: LoadNapiOptions): T {
  const { binaryName, callerMetaUrl } = options
  const suffix = NAPI_PLATFORM_MAP[`${platform}-${arch}`]
  if (!suffix) {
    throw new E_REAM_NAPI_UNSUPPORTED_PLATFORM([`${platform}-${arch}`])
  }

  const req = createRequire(callerMetaUrl)
  const dir = dirname(fileURLToPath(callerMetaUrl))
  const file = `${binaryName}.${suffix}.node`
  const candidates = [join(dir, '..', '..', file), join(dir, '..', file), join(dir, file)]

  for (const path of candidates) {
    try {
      return req(path)
    } catch (e) {
      const code = errorCode(e)
      if (code === 'MODULE_NOT_FOUND') continue
      // Any other error (SyntaxError, ABI mismatch, permissions,
      // corrupt binary) means the file exists but cannot load. Surface
      // the real cause rather than a generic "not found"; it names paths on
      // the host, so it travels as the `cause`, out of the message.
      throw new E_REAM_NAPI_LOAD_FAILED(
        [binaryName, `${file}, the local build`, localBuildFix(options.notFoundHint)],
        { cause: e },
      )
    }
  }

  // No local build: the binary of an installed ream is in its platform
  // package. The package has no `exports`, so the file resolves as a subpath,
  // from the caller (inside ream) as from ream itself: npm's flat layout and
  // pnpm's `.pnpm/<pkg>/node_modules` siblings alike.
  const platformPackage = napiPlatformPackage(suffix)
  const packaged = `${platformPackage}/${file}`
  try {
    return req(packaged)
  } catch (e) {
    if (errorCode(e) !== 'MODULE_NOT_FOUND') {
      throw new E_REAM_NAPI_LOAD_FAILED(
        [binaryName, packaged, platformPackageFix(platformPackage, suffix)],
        { cause: e },
      )
    }
    // The load error names paths on the host: it travels as the `cause`.
    throw Object.assign(
      new E_REAM_NAPI_NOT_FOUND(
        [binaryName, `${file} at the package root or in ${platformPackage}`],
        {
          cause: e,
        },
      ),
      { help: notFoundHelp(platformPackage, suffix, options.notFoundHint) },
    )
  }
}

/** The build command a checkout runs, unless the caller named its own. */
const BUILD_COMMAND = 'pnpm --filter @c9up/ream build:napi'

/**
 * On a musl host the glibc binary never loads: an older package manager that
 * ignores `libc` installs it anyway, and "not found" or "failed to load" then
 * sends the reader after the file rather than the libc. Name the real reason.
 */
function muslHint(suffix: string): string {
  return suffix.endsWith('-gnu')
    ? ' If you are on Alpine/musl, note the prebuilt Linux binaries target glibc — musl is not a supported target.'
    : ''
}

/** What to do about a binary found nowhere, phrased for whoever has to fix it. */
function notFoundHelp(platformPackage: string, suffix: string, hint: string | undefined): string {
  return (
    `Install ${platformPackage} at the exact version of @c9up/ream: it is the optional dependency that carries the ${suffix} binaries, ` +
    'and an install that omits optional dependencies (--no-optional, --omit=optional) skips it. ' +
    `${hint ?? `In a checkout of ream, build them instead: ${BUILD_COMMAND}.`}${muslHint(suffix)}`
  )
}

/** What to do about a local build that exists but does not load. */
function localBuildFix(hint: string | undefined): string {
  return hint ?? `rebuild it for this platform and Node version: ${BUILD_COMMAND}.`
}

/** What to do about an installed platform package whose binary does not load. */
function platformPackageFix(platformPackage: string, suffix: string): string {
  return (
    `reinstall ${platformPackage} at the exact version of @c9up/ream, on the machine that runs the app ` +
    `(a node_modules copied from another platform or Node version carries the wrong binary).${muslHint(suffix)}`
  )
}

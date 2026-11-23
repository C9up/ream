/**
 * Shared NAPI binary loader. Every `.node` file distributed with
 * `@c9up/ream` uses the same platform-suffix convention and lookup
 * strategy — extracting this helper avoids drift between the three
 * call sites (HyperServer, Scheduler, and future NAPI consumers) and
 * matches the codex review's "stop duplicating native loaders"
 * guidance.
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
export const NAPI_PLATFORM_MAP: Record<string, string> = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
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
  /** Hint appended to the "not found" error (typically a build command). */
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
 *
 * The three-level fallback matches the layout where the compiled
 * `.node` sits either at the package root, a subdirectory, or next to
 * the calling module.
 */
export function loadNapi<T>(options: LoadNapiOptions): T {
  const { binaryName, callerMetaUrl } = options
  const suffix = NAPI_PLATFORM_MAP[`${platform}-${arch}`]
  if (!suffix) {
    throw new E_REAM_NAPI_UNSUPPORTED_PLATFORM([`${platform}-${arch}`])
  }

  const req = createRequire(callerMetaUrl)
  const dir = dirname(fileURLToPath(callerMetaUrl))
  const candidates = [
    join(dir, '..', '..', `${binaryName}.${suffix}.node`),
    join(dir, '..', `${binaryName}.${suffix}.node`),
    join(dir, `${binaryName}.${suffix}.node`),
  ]

  for (const path of candidates) {
    try {
      return req(path) as T
    } catch (e) {
      const code = errorCode(e)
      if (code === 'MODULE_NOT_FOUND') continue
      // Any other error (SyntaxError, ABI mismatch, permissions,
      // corrupt binary) means the file exists but cannot load. Surface
      // the real cause rather than a generic "not found".
      throw new E_REAM_NAPI_LOAD_FAILED(
        [binaryName, path, e instanceof Error ? e.message : String(e)],
        {
          cause: e,
        },
      )
    }
  }

  // On a musl host the glibc binary is present but never loads, so "not found"
  // sends the reader looking for a missing file that is right there. Name the
  // real reason instead.
  const muslHint = suffix.endsWith('-gnu')
    ? ' If you are on Alpine/musl, note the prebuilt Linux binaries target glibc — musl is not a supported target.'
    : ''
  throw Object.assign(new E_REAM_NAPI_NOT_FOUND([binaryName, `${binaryName}.${suffix}.node`]), {
    help: `${
      options.notFoundHint ??
      "Run 'pnpm --filter @c9up/ream build:rust' to build the native module."
    }${muslHint}`,
  })
}

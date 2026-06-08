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
import { ReamError } from '../errors/ReamError.js'

/** Platform triple suffix (matches napi-rs naming). */
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
  /**
   * Error-code prefix used to build `<PREFIX>_NAPI_NOT_FOUND`,
   * `<PREFIX>_NAPI_LOAD_FAILED`, and `<PREFIX>_UNSUPPORTED_PLATFORM`
   * codes when loading fails. E.g. `"SCHEDULER"`.
   */
  errorCodePrefix: string
  /** Hint appended to the "not found" error (typically a build command). */
  notFoundHint?: string
}

/**
 * Resolve and `require` a Ream NAPI binary, returning the native
 * module export. Throws a typed `ReamError` on any failure.
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
  const { binaryName, callerMetaUrl, errorCodePrefix } = options
  const suffix = NAPI_PLATFORM_MAP[`${platform}-${arch}`]
  if (!suffix) {
    throw new ReamError(
      `${errorCodePrefix}_UNSUPPORTED_PLATFORM`,
      `Unsupported platform: ${platform}-${arch}`,
    )
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
      const code = (e as NodeJS.ErrnoException | undefined)?.code
      if (code === 'MODULE_NOT_FOUND') continue
      // Any other error (SyntaxError, ABI mismatch, permissions,
      // corrupt binary) means the file exists but cannot load. Surface
      // the real cause rather than a generic "not found".
      throw new ReamError(
        `${errorCodePrefix}_NAPI_LOAD_FAILED`,
        `${binaryName} NAPI binary exists at '${path}' but failed to load: ${(e as Error).message}`,
        {
          hint: 'Check that the binary was built for the current platform and Node ABI. Rebuild with `pnpm --filter @c9up/ream build:rust`.',
        },
      )
    }
  }

  throw new ReamError(
    `${errorCodePrefix}_NAPI_NOT_FOUND`,
    `${binaryName} NAPI binary not found. Expected ${binaryName}.${suffix}.node`,
    {
      hint:
        options.notFoundHint ??
        "Run 'pnpm --filter @c9up/ream build:rust' to build the native module.",
    },
  )
}

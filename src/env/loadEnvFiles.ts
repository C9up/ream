import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

/**
 * Load `.env` files into `process.env` — the shared primitive behind both the
 * Ignitor (HTTP/console boot) and `Env.create()` (config/test flow), mirroring
 * AdonisJS which loads env in every flow.
 *
 * Order is most-specific-first and "already-present wins", so the shell / CI
 * always overrides the files. Missing files are skipped silently. Uses Node's
 * built-in parser — no dependency.
 *
 * @param appRoot Directory URL the `.env*` files are resolved against.
 * @param options.skipEnvLocal Skip `.env.local` (the test flow does, so a
 *   developer's local overrides don't leak into tests).
 */
export function loadEnvFiles(appRoot: URL, options: { skipEnvLocal?: boolean } = {}): void {
  const nodeEnv = process.env.NODE_ENV
  const files = [
    nodeEnv ? `.env.${nodeEnv}.local` : null,
    options.skipEnvLocal ? null : '.env.local',
    nodeEnv ? `.env.${nodeEnv}` : null,
    '.env',
  ].filter((name): name is string => name !== null)

  for (const name of files) {
    let contents: string
    try {
      contents = readFileSync(fileURLToPath(new URL(name, appRoot)), 'utf8')
    } catch {
      continue // file absent — nothing to load
    }
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (typeof value === 'string' && process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
}

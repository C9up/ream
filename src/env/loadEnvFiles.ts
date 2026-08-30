import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { interpolate } from './interpolate.js'
import { normalizeNodeEnv } from './nodeEnv.js'

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
  // Normalised, so `NODE_ENV=prod` loads `.env.production` — the file the
  // deployment actually wrote — instead of looking for `.env.prod`.
  const raw = normalizeNodeEnv(process.env.NODE_ENV)
  const nodeEnv = raw === 'unknown' ? undefined : raw
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
    const parsed = parseEnv(contents)
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || process.env[key] !== undefined) continue
      // Interpolate `$VAR`/`${VAR}` against process.env then this file's own
      // (already-loaded) values, and apply any `identifier:` resolver.
      process.env[key] = interpolate(value, (name) => {
        const fromProcess = process.env[name]
        if (fromProcess !== undefined) return fromProcess
        const fromFile = parsed[name]
        return typeof fromFile === 'string' ? fromFile : undefined
      })
    }
  }
}

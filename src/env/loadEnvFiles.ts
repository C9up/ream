import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { interpolate } from './interpolate.js'
import { normalizeNodeEnv } from './nodeEnv.js'

/**
 * The `.env*` files that will be read, most-specific first.
 *
 * Exported because `@c9up/ream/hot` has to WATCH exactly this list: nothing
 * imports an env file, so hot-hook's dependency tree never sees one and an
 * edit to `.env` changed nothing at all. A second copy of the list in the
 * loader entry would drift from this one the first time the naming changes.
 *
 * @param options.skipEnvLocal Skip `.env.local` — see {@link loadEnvFiles}.
 */
export function envFileNames(options: { skipEnvLocal?: boolean } = {}): string[] {
  // Normalised, so `NODE_ENV=prod` loads `.env.production` — the file the
  // deployment actually wrote — instead of looking for `.env.prod`.
  const raw = normalizeNodeEnv(process.env.NODE_ENV)
  const nodeEnv = raw === 'unknown' ? undefined : raw
  return [
    nodeEnv ? `.env.${nodeEnv}.local` : null,
    options.skipEnvLocal ? null : '.env.local',
    nodeEnv ? `.env.${nodeEnv}` : null,
    '.env',
  ].filter((name): name is string => name !== null)
}

/**
 * Where the `.env*` files are read from.
 *
 * Normally beside the application, which is what `appRoot` names. A BUILT
 * application moves: `start/env.js` sits in `dist/`, so `new URL('../',
 * import.meta.url)` resolves there and the files at the project root become
 * invisible — `ream start` died on a `.env` it was standing next to.
 *
 * `ENV_PATH` is AdonisJS's own variable for this, named and shaped the same
 * way: a DIRECTORY to read the files from, as in
 * `ENV_PATH=/etc/secrets node server.js`. An application moving over keeps
 * whatever it already sets.
 *
 * It is also why the ordering rule stays here rather than in the CLI: node's
 * `--env-file` applies files last-wins while this loader applies them
 * most-specific-first, and a second copy of that would be one to keep in step
 * forever.
 */
function envDirectory(appRoot: URL): URL {
  const override = process.env.ENV_PATH
  if (override === undefined || override.trim() === '') return appRoot
  // A directory URL, so `new URL('.env', directory)` lands inside it rather
  // than beside it.
  return pathToFileURL(override.endsWith('/') ? override : `${override}/`)
}

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
  const directory = envDirectory(appRoot)
  let found = false
  for (const name of envFileNames(options)) {
    let contents: string
    try {
      contents = readFileSync(fileURLToPath(new URL(name, directory)), 'utf8')
    } catch {
      continue // file absent — nothing to load
    }
    found = true
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

  // Upstream raises when `ENV_PATH` names a place with no env file in it, and
  // for the reason silence would be wrong: the variable is somebody saying
  // where the file IS. A typo in the path would otherwise start a server on
  // whatever defaults happened to be around, which is how a deployment reads
  // its staging config in production and nobody finds out until later.
  //
  // Without `ENV_PATH` a missing file stays silent: an application may have
  // none at all, and every value may come from the environment.
  if (!found && process.env.ENV_PATH !== undefined && process.env.ENV_PATH.trim() !== '') {
    throw new Error(
      `ENV_PATH points at ${process.env.ENV_PATH}, which holds none of ${envFileNames(options).join(', ')}`,
    )
  }
}

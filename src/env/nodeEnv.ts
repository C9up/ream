/**
 * Reading `NODE_ENV`, with the aliases people actually set.
 *
 * `NODE_ENV=prod` is a normal thing to find in a Dockerfile or a platform's
 * dashboard, and a bare `=== 'production'` reads it as "not production": the
 * app then serves without Secure cookies, with development error pages, and
 * loads the wrong `.env` file. Normalising once, here, is what stops that
 * spelling from deciding how an application behaves.
 *
 * The tables mirror upstream exactly. Anything outside them is handed back
 * lowercased rather than forced into a bucket — `staging` stays `staging`, so
 * `.env.staging` still resolves.
 */

const DEV_ENVS = ['dev', 'develop', 'development']
const PROD_ENVS = ['prod', 'production']
const TEST_ENVS = ['test', 'testing']

/**
 * The canonical name for whatever `NODE_ENV` holds.
 *
 * Returns `'unknown'` when it is unset — an absent environment is not the
 * development one, and pretending otherwise turns a misconfigured deploy into
 * a silently permissive one.
 */
export function normalizeNodeEnv(value: string | undefined): string {
  if (!value || typeof value !== 'string') return 'unknown'
  const env = value.toLowerCase()
  if (DEV_ENVS.includes(env)) return 'development'
  if (PROD_ENVS.includes(env)) return 'production'
  if (TEST_ENVS.includes(env)) return 'test'
  return env
}

/** The current environment, normalised. */
export function currentNodeEnv(): string {
  return normalizeNodeEnv(process.env.NODE_ENV)
}

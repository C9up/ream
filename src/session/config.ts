/**
 * `config/session.ts` — the session store's configuration, in the file the
 * config loader reads (`config/<name>.ts` → `config.get('<name>')`).
 *
 * @example
 *   // config/session.ts
 *   import env from '#start/env.js'
 *   import { defineConfig } from '@c9up/ream/session/config'
 *
 *   export default defineConfig({
 *     store: 'cookie',
 *     secret: env.get('APP_KEY'),
 *   })
 */

import { E_SESSION_STORE_NOT_CONFIGURED } from './errors.js'
import type { SessionConfig } from './Session.js'

/** What a session config file may declare. */
export type SessionConfigInput = SessionConfig & {
  /**
   * Signs the session cookie. Required by the cookie store, which carries the
   * data itself and would otherwise hand the client something it could edit.
   */
  secret?: string
}

/**
 * Validate and return a session config. A config without `store` (or its
 * older spelling `driver`) is refused here, at load time, as AdonisJS'
 * `defineConfig` refuses it: there is no implicit store.
 */
export function defineConfig(config: SessionConfigInput): SessionConfigInput {
  if (!config.store && !config.driver) throw new E_SESSION_STORE_NOT_CONFIGURED()
  return config
}

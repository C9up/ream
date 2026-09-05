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

import type { SessionConfig } from './Session.js'

/** What a session config file may declare. */
export type SessionConfigInput = SessionConfig & {
  /**
   * Signs the session cookie. Required by the cookie store, which carries the
   * data itself and would otherwise hand the client something it could edit.
   */
  secret?: string
}

export function defineConfig(config: SessionConfigInput): SessionConfigInput {
  return config
}

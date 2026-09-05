/**
 * Reading a module's own `config/<name>.ts` entry without demanding one.
 *
 * A middleware constructed by the container gets nothing passed to it — the
 * resolver calls `make(Class)`, which is what makes `router.use([() =>
 * import('…/session_middleware')])` possible. The configuration therefore has
 * to come from the config store, the way it does everywhere else.
 *
 * The read is deliberately forgiving. The same classes are also constructed
 * directly (`new BodyParserMiddleware()`) in tests and in embedding hosts that
 * never boot an Application, and there the store does not exist. Throwing there
 * would trade a working default for a crash.
 */

import { getApp } from '../services/app.js'

export function readModuleConfig<T extends object>(key: string): T | undefined {
  const store = getApp()?.config
  if (store === undefined || !store.has(key)) return undefined
  const value = store.get<T>(key)
  // A config file exporting something that is not an object (a stray
  // `export default 42`) is ignored rather than spread over the defaults.
  return typeof value === 'object' && value !== null ? value : undefined
}

/**
 * Application logger singleton service.
 *
 * Usage:
 *   import logger from '@c9up/ream/services/logger'
 *   logger.info('user signed in', { userId })
 *
 * ream does not implement the logger — it declares the contract
 * ({@link ContextLogger}) and reads whatever a provider bound as `'logger'`.
 * `@c9up/spectrum` is the implementation in this universe, the way `hash` is
 * sigil's and validation is rune's.
 *
 * `ctx.logger` stays the right thing to use inside a request: it is
 * correlation-scoped. This is for everywhere else — a provider, a scheduled
 * task, a console command — where there is no request to scope to.
 */

import type { ChildLoggerSource } from '../http/HttpContext.js'
import { createServiceProxy } from './createServiceProxy.js'

let instance: ChildLoggerSource | undefined

/** @internal Set the logger (called by Ignitor once providers have booted). */
export function setLogger(logger: ChildLoggerSource): void {
  instance = logger
}

/**
 * @internal Unset the locator IF it still points at `logger` (called by
 * Ignitor.stop()). Ownership-guarded — see services/app.ts.
 */
export function clearLogger(logger: ChildLoggerSource): void {
  if (instance === logger) instance = undefined
}

/** @internal Get the logger directly. */
export function getLogger(): ChildLoggerSource | undefined {
  return instance
}

const logger: ChildLoggerSource = createServiceProxy<ChildLoggerSource>(
  () => instance,
  'Logger accessed before initialization. ' +
    'ream declares the contract but implements no logger — install one (`@c9up/spectrum`) ' +
    "and register its provider, which binds it as 'logger'. Inside a request, prefer " +
    '`ctx.logger`, which is scoped to the correlation id.',
)

export default logger

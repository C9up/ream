/**
 * Application singleton service.
 *
 * Usage:
 *   import app from '@c9up/ream/services/app'
 *   const logger = await app.container.make('logger')
 *   if (app.inProduction) { ... }
 */

import type { Application } from '../Application.js'
import { createServiceProxy } from './createServiceProxy.js'

let instance: Application | undefined

/** @internal Set the app instance (called by Ignitor). */
export function setApp(app: Application): void {
  instance = app
}

/**
 * @internal Unset the locator IF it still points at `app` (called by
 * Ignitor.stop()). Ownership-guarded: when a second Ignitor rebound the
 * locator, the older app's stop() must not tear down the newer binding.
 */
export function clearApp(app: Application): void {
  if (instance === app) instance = undefined
}

/**
 * @internal Get the app instance directly. Used by the accessors that stand in
 * for something the app OWNS (`services/config` is `app.config`), so they read
 * through here instead of keeping a second copy that a re-boot could desync.
 */
export function getApp(): Application | undefined {
  return instance
}

const app: Application = createServiceProxy<Application>(
  () => instance,
  'Application accessed before initialization. ' +
    'Ensure this code runs during or after the boot phase.',
)

export default app

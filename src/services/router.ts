/**
 * Router singleton service — proxy to the Ignitor's router instance.
 *
 * Usage in module route files:
 *   import router from '@c9up/ream/services/router'
 *   router.get('/tasks', [TasksController, 'index'])
 *
 * The proxy is initialized by Ignitor before preload files are imported.
 */

import type { Router } from '../router/Router.js'
import { createServiceProxy } from './createServiceProxy.js'

let instance: Router | undefined

/** @internal Set the router instance (called by Ignitor). */
export function setRouter(router: Router): void {
  instance = router
}

/**
 * @internal Unset the locator IF it still points at `router` (called by
 * Ignitor.stop()). Ownership-guarded — see services/app.ts.
 */
export function clearRouter(router: Router): void {
  if (instance === router) instance = undefined
}

/** @internal Get the router instance directly. */
export function getRouter(): Router | undefined {
  return instance
}

/**
 * Router proxy — defers all property access to the underlying instance.
 * Throws if accessed before Ignitor initializes it.
 */
const router: Router = createServiceProxy<Router>(
  () => instance,
  'Router accessed before initialization. ' +
    'Ensure your route files are loaded as preloads in reamrc.ts, not at import time.',
)

export default router

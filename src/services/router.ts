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

let _instance: Router | undefined

/** @internal Set the router instance (called by Ignitor). */
export function _setRouter(router: Router): void {
  _instance = router
}

/** @internal Get the router instance directly. */
export function _getRouter(): Router | undefined {
  return _instance
}

/**
 * Router proxy — defers all property access to the underlying instance.
 * Throws if accessed before Ignitor initializes it.
 */
const router: Router = new Proxy({} as Router, {
  get(_target, prop, receiver) {
    if (!_instance) {
      throw new Error(
        'Router accessed before initialization. '
        + 'Ensure your route files are loaded as preloads in reamrc.ts, not at import time.',
      )
    }
    return Reflect.get(_instance, prop, receiver)
  },
})

export default router

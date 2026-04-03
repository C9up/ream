/**
 * Application singleton service.
 *
 * Usage:
 *   import app from '@c9up/ream/services/app'
 *   const logger = app.container.make('logger')
 *   if (app.inProduction) { ... }
 */

import type { Application } from '../Application.js'

let _instance: Application | undefined

/** @internal Set the app instance (called by Ignitor). */
export function _setApp(app: Application): void {
  _instance = app
}

const app: Application = new Proxy({} as Application, {
  get(_target, prop, receiver) {
    if (!_instance) {
      throw new Error(
        'Application accessed before initialization. '
        + 'Ensure this code runs during or after the boot phase.',
      )
    }
    return Reflect.get(_instance, prop, receiver)
  },
})

export default app

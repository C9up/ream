/**
 * Application singleton service.
 *
 * Usage:
 *   import app from '@c9up/ream/services/app'
 *   const logger = app.container.make('logger')
 *   if (app.inProduction) { ... }
 */

import type { Application } from '../Application.js'

let instance: Application | undefined

/** @internal Set the app instance (called by Ignitor). */
export function setApp(app: Application): void {
  instance = app
}

const app: Application = new Proxy({} as Application, {
  get(_target, prop) {
    if (!instance) {
      throw new Error(
        'Application accessed before initialization. ' +
          'Ensure this code runs during or after the boot phase.',
      )
    }
    // Bind methods so private-field writes inside the class resolve
    // against the real instance brand instead of the Proxy.
    const value = Reflect.get(instance, prop, instance)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

export default app

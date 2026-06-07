/**
 * Server singleton service — proxy to the Ignitor's Server instance.
 *
 * Usage in start/kernel.ts:
 *   import server from '@c9up/ream/services/server'
 *   server.errorHandler(() => import('#exceptions/handler'))
 *   server.use([() => import('#middleware/logging')])
 */

import type { Server } from '../server/Server.js'

let instance: Server | undefined

/** @internal Set the server instance (called by Ignitor). */
export function setServer(server: Server): void {
  instance = server
}

/** @internal Get the server instance directly. */
export function getServer(): Server | undefined {
  return instance
}

const server: Server = new Proxy({} as Server, {
  get(_target, prop) {
    if (!instance) {
      throw new Error(
        'Server accessed before initialization. ' +
          'Ensure your kernel files are loaded as preloads in reamrc.ts.',
      )
    }
    // Bind methods to the real instance so private-field access inside
    // them resolves against the underlying class brand — passing the
    // Proxy as `this` breaks `#field` writes (Proxy isn't branded).
    const value = Reflect.get(instance, prop, instance)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

export default server

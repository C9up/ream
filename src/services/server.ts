/**
 * Server singleton service — proxy to the Ignitor's Server instance.
 *
 * Usage in start/kernel.ts:
 *   import server from '@c9up/ream/services/server'
 *   server.errorHandler(() => import('#exceptions/handler'))
 *   server.use([() => import('#middleware/logging')])
 */

import type { Server } from '../server/Server.js'

let _instance: Server | undefined

/** @internal Set the server instance (called by Ignitor). */
export function _setServer(server: Server): void {
  _instance = server
}

/** @internal Get the server instance directly. */
export function _getServer(): Server | undefined {
  return _instance
}

const server: Server = new Proxy({} as Server, {
  get(_target, prop, receiver) {
    if (!_instance) {
      throw new Error(
        'Server accessed before initialization. '
        + 'Ensure your kernel files are loaded as preloads in reamrc.ts.',
      )
    }
    return Reflect.get(_instance, prop, receiver)
  },
})

export default server

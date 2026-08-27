/**
 * Server singleton service — proxy to the Ignitor's Server instance.
 *
 * Usage in start/kernel.ts:
 *   import server from '@c9up/ream/services/server'
 *   server.errorHandler(() => import('#exceptions/handler'))
 *   server.use([() => import('#middleware/logging')])
 */

import type { Server } from '../server/Server.js'
import { createServiceProxy } from './createServiceProxy.js'

let instance: Server | undefined

/** @internal Set the server instance (called by Ignitor). */
export function setServer(server: Server): void {
  instance = server
}

/**
 * @internal Unset the locator IF it still points at `server` (called by
 * Ignitor.stop()). Ownership-guarded — see services/app.ts.
 */
export function clearServer(server: Server): void {
  if (instance === server) instance = undefined
}

/** @internal Get the server instance directly. */
export function getServer(): Server | undefined {
  return instance
}

const server: Server = createServiceProxy<Server>(
  () => instance,
  'Server accessed before initialization. ' +
    'Ensure your kernel files are loaded as preloads in reamrc.ts.',
)

export default server

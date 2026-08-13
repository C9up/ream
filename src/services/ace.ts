/**
 * Ace singleton service.
 *
 * Usage:
 *   import ace from '@c9up/ream/services/ace'
 *   if (await ace.hasCommand('make:controller')) {
 *     const command = await ace.exec('make:controller', ['user', '--resource'])
 *   }
 */

import type { Ace } from '../console/Ace.js'

let instance: Ace | undefined

/** @internal Set the ace instance (called by Ignitor). */
export function setAce(ace: Ace): void {
  instance = ace
}

/**
 * @internal Unset the locator IF it still points at `ace` (called by
 * Ignitor.stop()) — same ownership guard as the app service: a second Ignitor
 * rebinding the locator must not be torn down by the first one stopping.
 */
export function clearAce(ace: Ace): void {
  if (instance === ace) instance = undefined
}

const ace: Ace = new Proxy({} as Ace, {
  get(_target, prop) {
    if (!instance) {
      throw new Error(
        'Ace accessed before initialization. ' +
          'Ensure this code runs during or after the boot phase.',
      )
    }
    const value = Reflect.get(instance, prop, instance)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

export default ace

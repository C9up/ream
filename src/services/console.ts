/**
 * Console singleton service.
 *
 * Usage:
 *   import consoleApp from '@c9up/ream/services/console'
 *   if (await consoleApp.hasCommand('make:controller')) {
 *     const command = await consoleApp.exec('make:controller', ['user', '--resource'])
 *   }
 */

import type { Console } from '../console/Console.js'

let instance: Console | undefined

/** @internal Set the consoleApp instance (called by Ignitor). */
export function setConsole(consoleApp: Console): void {
  instance = consoleApp
}

/**
 * @internal Unset the locator IF it still points at `consoleApp` (called by
 * Ignitor.stop()) — same ownership guard as the app service: a second Ignitor
 * rebinding the locator must not be torn down by the first one stopping.
 */
export function clearConsole(consoleApp: Console): void {
  if (instance === consoleApp) instance = undefined
}

const consoleApp: Console = new Proxy({} as Console, {
  get(_target, prop) {
    // A module loader inspects what it imports before anyone uses it: it reads
    // `then` to decide whether the namespace is thenable, and various symbols
    // for interop and formatting. Throwing on those turns a plain
    // `import { setX } from '.../services/x'` into a crash at import time, far
    // from any real use. They are not members of what this stands in for, so
    // answer undefined and let a genuine access be the one that reports.
    if (typeof prop === 'symbol' || prop === 'then') {
      return undefined
    }
    if (!instance) {
      throw new Error(
        'Console accessed before initialization. ' +
          'Ensure this code runs during or after the boot phase.',
      )
    }
    const value = Reflect.get(instance, prop, instance)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

export default consoleApp

/**
 * Default `Emitter` singleton — mirror of Adonis's
 * `import emitter from '@adonisjs/core/services/emitter'` shape.
 *
 *   import emitter from '@c9up/ream/events/services/main'
 *
 *   emitter.on(TaskAssigned, (e) => sendEmail(e.assigneeId))
 *
 * Populated by `EventsProvider.boot()`.
 */

import type { Emitter } from '../Emitter.js'

let _instance: Emitter | undefined

/** @internal Bind the singleton (called by EventsProvider). */
export function _setEmitter(instance: Emitter): void {
  _instance = instance
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getEmitter(): Emitter | undefined {
  return _instance
}

const emitter: Emitter = new Proxy({} as Emitter, {
  get(_target, prop) {
    if (!_instance) {
      throw new Error(
        '[ream:events] Emitter singleton accessed before EventsProvider.boot() ran. ' +
          'Check that `@c9up/ream/events/provider` is listed in your reamrc.ts providers.',
      )
    }
    const value = Reflect.get(_instance, prop, _instance)
    return typeof value === 'function' ? value.bind(_instance) : value
  },
})

export default emitter

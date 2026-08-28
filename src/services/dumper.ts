/**
 * Dumper singleton service.
 *
 *   import { dd } from '@c9up/ream/services/dumper'
 *   dd(user)
 *
 *   import dumper from '@c9up/ream/services/dumper'
 *   dumper.configureAnsiOutput({ depth: 8 })
 *
 * Unlike the other accessors this one holds a real instance rather than a
 * proxy: the dumper depends on nothing the boot phase builds, and something
 * you reach for mid-debug should not require a booted application.
 */

import { Dumper } from '../dumper/Dumper.js'

const dumper = new Dumper()

/**
 * Dump and die — AdonisJS's `dd`.
 *
 * The trace index is 2, not the default 1: the frame above is this function,
 * so the caller of `dd` is one further out. Without it, every dump would
 * report this file as its source.
 */
export const dd = (value: unknown): void => {
  dumper.dd(value, 2)
}

export default dumper

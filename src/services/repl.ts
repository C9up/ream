/**
 * REPL singleton service.
 *
 *   // start/repl.ts, imported as a preload for the `repl` environment
 *   import repl from '@c9up/ream/services/repl'
 *   import { UserEntity } from '#app/entities/user'
 *
 *   repl.addMethod('users', () => UserEntity, {
 *     description: 'The user entity, for querying at the prompt',
 *   })
 *
 * Holds a real instance rather than a proxy: helpers are registered BEFORE the
 * prompt starts — that is the point of registering them — so the object has to
 * exist before anything boots it.
 */

import { Repl } from '../repl/Repl.js'

const repl = new Repl()

export default repl

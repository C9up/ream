/**
 * Session exceptions, under the codes AdonisJS raises.
 *
 * The conditions were already guarded — they just threw bare `Error`s, so an
 * app could only match on the message text.
 *
 * `E_SESSION_NOT_MUTABLE` has no counterpart here on purpose: it is what
 * AdonisJS raises for a session initiated in read-only mode, and ream has no
 * read-only mode. Declaring the class with nothing able to throw it would be
 * worse than its absence — an app would guard a branch that never runs.
 */

import { Exception } from '../http/Exception.js'

/** The session was used before a store was attached to it. */
export class E_SESSION_NOT_READY extends Exception {
  static override status = 500
  static override code = 'E_SESSION_NOT_READY'

  constructor(method: string) {
    super(`session.${method}() needs a session store — this session was built without one.`, {
      status: 500,
      code: 'E_SESSION_NOT_READY',
    })
  }
}

/** The configured store cannot tag sessions (cookie and file stores cannot). */
export class E_SESSION_TAGGING_NOT_SUPPORTED extends Exception {
  static override status = 500
  static override code = 'E_SESSION_TAGGING_NOT_SUPPORTED'

  constructor(method: string) {
    super(
      `session.${method}() is not supported by the configured session store. Use the memory, redis, or database store.`,
      { status: 500, code: 'E_SESSION_TAGGING_NOT_SUPPORTED' },
    )
  }
}

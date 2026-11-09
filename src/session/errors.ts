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

/**
 * A store with no `update()`: it cannot write a session back only while its
 * entry still exists, so a request running across a logout could sign the
 * user in again. Refused when the store is attached, not at the first race.
 */
export class E_SESSION_STORE_NOT_CONDITIONAL extends Exception {
  static override status = 500
  static override code = 'E_SESSION_STORE_NOT_CONDITIONAL'

  constructor() {
    super(
      'This session store has no update(): it must write a session only over an entry that still exists, in one step. See "Writing a session store".',
      { status: 500, code: 'E_SESSION_STORE_NOT_CONDITIONAL' },
    )
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

/**
 * A session config without a store (AdonisJS raises "Missing store" for the
 * same config). There is no implicit fallback: the memory store is per
 * process and bounded — a restart, a second replica or enough anonymous
 * traffic signs every user out — so it is only used when it is chosen.
 */
export class E_SESSION_STORE_NOT_CONFIGURED extends Exception {
  static override status = 500
  static override code = 'E_SESSION_STORE_NOT_CONFIGURED'

  constructor() {
    super(
      "No session store is configured. Set `store` in config/session.ts (redis, database, file or cookie), or `store: 'memory'` for sessions kept in this process only (tests, a single development instance).",
      { status: 500, code: 'E_SESSION_STORE_NOT_CONFIGURED' },
    )
  }
}

/** `cookie.httpOnly: false` — the session id would be readable by any script on the page. */
export class E_SESSION_COOKIE_NOT_HTTP_ONLY extends Exception {
  static override status = 500
  static override code = 'E_SESSION_COOKIE_NOT_HTTP_ONLY'

  constructor() {
    super(
      'The session cookie must be httpOnly: a script able to read it turns any XSS into an account takeover. Remove `cookie.httpOnly: false` from the session config.',
      { status: 500, code: 'E_SESSION_COOKIE_NOT_HTTP_ONLY' },
    )
  }
}

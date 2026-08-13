/**
 * `isReamError` — the guard that replaces `instanceof MyError`.
 *
 * The framework carries one error type with a code, because an error can cross
 * the NAPI boundary; a class per code cannot.
 */

import { describe, expect, it } from 'vitest'
import { isReamError, ReamError } from '../../src/errors/ReamError.js'

describe('isReamError', () => {
  it('recognises a Ream error, whatever its code', () => {
    expect(isReamError(new ReamError('E_ANY', 'boom'))).toBe(true)
    expect(isReamError(new Error('boom'))).toBe(false)
    expect(isReamError('boom')).toBe(false)
    expect(isReamError(undefined)).toBe(false)
  })

  it('matches any of the codes it is given', () => {
    const error = new ReamError('E_CONSOLE_MISSING_FLAG', 'Missing required flag "--email".')

    expect(isReamError(error, 'E_CONSOLE_MISSING_FLAG')).toBe(true)
    expect(isReamError(error, 'E_CONSOLE_MISSING_ARGUMENT', 'E_CONSOLE_MISSING_FLAG')).toBe(true)
    expect(isReamError(error, 'E_CONSOLE_UNKNOWN_FLAG')).toBe(false)
  })

  it('narrows the error, and its code, for the compiler', () => {
    const error: unknown = new ReamError('E_CONSOLE_MISSING_FLAG', 'nope', { hint: 'pass --email' })

    if (!isReamError(error, 'E_CONSOLE_MISSING_FLAG')) {
      throw new Error('expected the guard to match')
    }

    // Both of these only compile because the guard narrowed: `hint` belongs to
    // ReamError, and `code` to the literal that was asked for.
    const code: 'E_CONSOLE_MISSING_FLAG' = error.code
    expect(code).toBe('E_CONSOLE_MISSING_FLAG')
    expect(error.hint).toBe('pass --email')
  })

  it('does not match a plain object that merely looks like one', () => {
    // Deliberately `instanceof`: an error rebuilt from Rust IS a ReamError
    // (see fromNapi), so nothing legitimate is missed, and a random object
    // carrying a `code` is not an error.
    expect(isReamError({ code: 'E_CONSOLE_MISSING_FLAG', message: 'nope' })).toBe(false)
  })
})

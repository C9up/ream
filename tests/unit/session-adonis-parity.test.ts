/**
 * The AdonisJS session surface a migrated app calls: reflashing across a
 * redirect chain, the intended URL an auth middleware stores before sending
 * the user to login, and validation errors in the shape the `@error` tags read.
 */
import { describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'

const withPrevious = (flash: Record<string, unknown>): Session =>
  new Session('sid', { __flash: flash })

describe('ream > session reflash', () => {
  it('keeps the previous flash for one more request', () => {
    const s = withPrevious({ notice: 'saved', errorsBag: { a: 'x' } })
    s.reflash()
    expect(s.toJSON().__flash).toEqual({
      notice: 'saved',
      errorsBag: { a: 'x' },
    })
  })

  it('keeps only what is named', () => {
    const s = withPrevious({ notice: 'saved', noise: 1 })
    s.reflashOnly(['notice'])
    expect(s.toJSON().__flash).toEqual({ notice: 'saved' })
  })

  it('keeps everything but what is named', () => {
    const s = withPrevious({ notice: 'saved', noise: 1 })
    s.reflashExcept(['noise'])
    expect(s.toJSON().__flash).toEqual({ notice: 'saved' })
  })
})

describe('ream > intended URL', () => {
  it('remembers where the user was heading, then forgets it', () => {
    const s = new Session('sid')
    expect(s.getIntendedUrl()).toBeNull()

    s.setIntendedUrl('/admin/reports')
    expect(s.getIntendedUrl()).toBe('/admin/reports')

    // The usual call right after a successful login.
    expect(s.pullIntendedUrl()).toBe('/admin/reports')
    expect(s.getIntendedUrl()).toBeNull()
  })

  it('can be cleared without being read', () => {
    const s = new Session('sid')
    s.setIntendedUrl('/x')
    s.clearIntendedUrl()
    expect(s.getIntendedUrl()).toBeNull()
  })
})

describe('ream > validation errors', () => {
  it('flashes the shape the @error tags read, plus the input', () => {
    const s = new Session('sid')
    s.setInputReader(() => ({ email: 'not-an-email' }))
    s.flashValidationErrors({
      code: 'E_VALIDATION_ERROR',
      messages: [
        { field: 'email', message: 'Must be an email' },
        { field: 'email', message: 'Already taken' },
      ],
    })

    const flash = s.toJSON().__flash as Record<string, unknown>
    // `@inputError('email')` reads this one.
    expect(flash.inputErrorsBag).toEqual({
      email: ['Must be an email', 'Already taken'],
    })
    // `@errors` reads this one.
    expect(flash.errorsBag).toEqual({
      E_VALIDATION_ERROR: ['Must be an email', 'Already taken'],
    })
    // And the form keeps what the user typed.
    expect(flash.input).toEqual({ email: 'not-an-email' })
  })

  it('can leave the input out', () => {
    const s = new Session('sid')
    s.setInputReader(() => ({ email: 'x' }))
    s.flashValidationErrors({ messages: [] }, false)
    expect((s.toJSON().__flash as Record<string, unknown>).input).toBeUndefined()
  })

  it('flashErrors puts a collection straight in the errors bag', () => {
    const s = new Session('sid')
    s.flashErrors({ name: 'Required', email: ['Invalid', 'Taken'] })
    expect((s.toJSON().__flash as Record<string, unknown>).errorsBag).toEqual({
      name: 'Required',
      email: ['Invalid', 'Taken'],
    })
  })
})

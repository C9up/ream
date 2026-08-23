/**
 * Session value + flash API (the non-rolling core). regenerate()/rolling and
 * the middleware live in session-rolling.test.ts; this covers get/put/has/
 * forget/pull/clear/increment/decrement, the flash lifecycle, and the
 * __flash serialization round-trip.
 */
import { describe, expect, it } from 'vitest'
import { Session } from '../../src/session/Session.js'

describe('Session > value API', () => {
  it('put/get/has/forget with a default fallback', () => {
    const s = new Session('sid')
    expect(s.isDirty()).toBe(false)
    s.put('name', 'Kaen')
    expect(s.get('name')).toBe('Kaen')
    expect(s.has('name')).toBe(true)
    expect(s.get('missing', 'def')).toBe('def')
    expect(s.isDirty()).toBe(true) // put() marks dirty
    s.forget('name')
    expect(s.has('name')).toBe(false)
  })

  it('pull returns then removes the key', () => {
    const s = new Session('sid', { token: 'abc' })
    expect(s.pull('token')).toBe('abc')
    expect(s.has('token')).toBe(false)
  })

  it('all() returns a copy (mutating it does not touch the session)', () => {
    const s = new Session('sid', { a: 1 })
    const snapshot = s.all()
    snapshot.a = 999
    expect(s.get('a')).toBe(1)
  })

  it('clear wipes everything', () => {
    const s = new Session('sid', { a: 1, b: 2 })
    s.clear()
    expect(s.all()).toEqual({})
  })

  it('increment / decrement default to 0 and step by 1', () => {
    const s = new Session('sid')
    s.increment('views')
    s.increment('views', 4)
    s.decrement('views')
    expect(s.get('views')).toBe(4)
  })
})

describe('Session > flash lifecycle', () => {
  it('extracts __flash from incoming data into the previous-request messages', () => {
    const s = new Session('sid', { user: 1, __flash: { success: 'Saved!' } })
    expect(s.flashMessages()).toEqual({ success: 'Saved!' })
    expect(s.old('success')).toBe('Saved!')
    expect(s.old('nope', 'fallback')).toBe('fallback')
    // __flash must not leak into the live data.
    expect(s.has('__flash')).toBe(false)
    expect(s.get('user')).toBe(1)
  })

  it('flash stages a key or an object for the next request', () => {
    const s = new Session('sid')
    s.flash('msg', 'hi')
    s.flash({ notice: 'saved' })
    expect(s.toJSON().__flash).toEqual({ msg: 'hi', notice: 'saved' })
  })

  it('flashAll / flashOnly / flashExcept read the request input themselves', () => {
    // AdonisJS `flashAll()` takes NO argument — it flashes `request.original()`
    // under `input`, which is what repopulates a form after a redirect-back.
    const s = new Session('sid')
    s.setInputReader(() => ({ email: 'a@b.test', password: 'secret', _csrf: 'x' }))

    s.flashAll()
    expect(s.toJSON().__flash).toEqual({
      input: { email: 'a@b.test', password: 'secret', _csrf: 'x' },
    })

    const only = new Session('sid')
    only.setInputReader(() => ({ email: 'a@b.test', password: 'secret' }))
    only.flashOnly(['email'])
    expect(only.toJSON().__flash).toEqual({ input: { email: 'a@b.test' } })

    const except = new Session('sid')
    except.setInputReader(() => ({ email: 'a@b.test', password: 'secret' }))
    except.flashExcept(['password'])
    expect(except.toJSON().__flash).toEqual({ input: { email: 'a@b.test' } })
  })

  it('flashes nothing rather than throwing outside a request', () => {
    const s = new Session('sid')
    expect(() => s.flashAll()).not.toThrow()
    expect(s.toJSON().__flash).toEqual({ input: {} })
  })

  it('toJSON omits __flash when no flash data was staged', () => {
    const s = new Session('sid', { a: 1 })
    expect(s.toJSON()).toEqual({ a: 1 })
  })

  it('round-trips: this request’s flash becomes next request’s old()', () => {
    const first = new Session('sid')
    first.flash('notice', 'done')
    const persisted = first.toJSON()
    const next = new Session('sid', persisted)
    expect(next.old('notice')).toBe('done')
  })
})

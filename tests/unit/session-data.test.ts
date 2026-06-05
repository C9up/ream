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

  it('flash / flashAll / flashOnly / flashExcept stage data for next request', () => {
    const s = new Session('sid')
    s.flash('msg', 'hi')
    s.flashAll({ a: 1, b: 2 })
    s.flashOnly({ x: 1, y: 2 }, ['x'])
    s.flashExcept({ keep: 1, drop: 2 }, ['drop'])
    const out = s.toJSON()
    expect(out.__flash).toEqual({ msg: 'hi', a: 1, b: 2, x: 1, keep: 1 })
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

/**
 * Duration parsing, checked against what AdonisJS actually accepts.
 *
 * Adonis pipes every duration through `string.seconds.parse` (@poppinss/string
 * → @lukeed/ms). These cases were read off that implementation, not off the
 * guides: a config value like `age: '2 hours'` moves over verbatim when an app
 * migrates, so anything this rejects is a portability break.
 */
import { describe, expect, it } from 'vitest'
import { durationToSeconds, parseDurationMs } from '../../src/helpers/duration.js'

describe('ream > duration parsing (AdonisJS parity)', () => {
  it('leaves a number alone — it is already seconds', () => {
    // `seconds.parse` opens with `if (typeof duration === 'number') return duration`.
    // Reading a number as milliseconds would divide every configured lifetime
    // by 1000.
    expect(durationToSeconds(7200, 'a maxAge')).toBe(7200)
    expect(durationToSeconds(0, 'a maxAge')).toBe(0)
  })

  it('accepts the long spellings a migrated config carries', () => {
    expect(durationToSeconds('2 hours', 'a maxAge')).toBe(7200)
    expect(durationToSeconds('30 minutes', 'a maxAge')).toBe(1800)
    expect(durationToSeconds('1 day', 'a maxAge')).toBe(86400)
    expect(durationToSeconds('2 weeks', 'a maxAge')).toBe(1209600)
    expect(durationToSeconds('1 year', 'a maxAge')).toBe(31557600)
  })

  it('accepts the short and medium spellings too', () => {
    expect(durationToSeconds('2h', 'a maxAge')).toBe(7200)
    expect(durationToSeconds('2hrs', 'a maxAge')).toBe(7200)
    expect(durationToSeconds('30m', 'a maxAge')).toBe(1800)
    expect(durationToSeconds('30 mins', 'a maxAge')).toBe(1800)
    expect(durationToSeconds('7d', 'a maxAge')).toBe(604800)
    expect(durationToSeconds('1w', 'a maxAge')).toBe(604800)
  })

  it('reads a UNITLESS string as milliseconds, as @lukeed/ms does', () => {
    // The counter-intuitive one: Adonis' '7200' is seven seconds, not two
    // hours. Assuming seconds here would quietly stretch it a thousandfold.
    expect(durationToSeconds('7200', 'a maxAge')).toBe(7)
    expect(durationToSeconds('500ms', 'a maxAge')).toBe(0)
    expect(durationToSeconds('90000', 'a maxAge')).toBe(90)
  })

  it('parses fractional amounts', () => {
    expect(parseDurationMs('1.5h')).toBe(5400000)
    expect(durationToSeconds('1.5 hours', 'a maxAge')).toBe(5400)
  })

  it('rejects what @lukeed/ms rejects', () => {
    expect(parseDurationMs('tomorrow')).toBeUndefined()
    expect(parseDurationMs('2 fortnights')).toBeUndefined()
    expect(parseDurationMs('')).toBeUndefined()
    // A zero amount is falsy in the upstream guard, so it is not a duration.
    expect(parseDurationMs('0 hours')).toBeUndefined()
  })

  it('names what failed, and what is accepted', () => {
    expect(() => durationToSeconds('tomorrow', 'a session age')).toThrow(
      /Cannot read "tomorrow" as a session age/,
    )
  })
})

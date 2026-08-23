/**
 * AdonisJS types cookie `maxAge` as `number | string` and parses the string
 * form ("in seconds or as a string", `string.seconds.parse`). ream took a
 * number only, so a migrated `maxAge: '2h'` reached the header as `Max-Age=2h`
 * — invalid, and the cookie was dropped without a word.
 */
import { describe, expect, it } from 'vitest'
import { Response as ReamResponse } from '../../src/http/Response.js'

function setCookie(maxAge: number | string): string {
  const res = new ReamResponse()
  res.plainCookie('session', 'abc', { maxAge })
  return res.getHeaders()['set-cookie'] ?? ''
}

describe('ream > cookie maxAge', () => {
  it('takes a bare number as seconds, like AdonisJS', () => {
    expect(setCookie(7200)).toContain('Max-Age=7200')
  })

  it('reads the duration strings a migrated config carries', () => {
    expect(setCookie('2h')).toContain('Max-Age=7200')
    expect(setCookie('30m')).toContain('Max-Age=1800')
    expect(setCookie('45s')).toContain('Max-Age=45')
    expect(setCookie('7d')).toContain('Max-Age=604800')
    expect(setCookie('1w')).toContain('Max-Age=604800')
  })

  it('still deletes with maxAge 0', () => {
    expect(setCookie(0)).toContain('Max-Age=0')
  })

  it('refuses a duration it cannot read instead of voiding the cookie', () => {
    expect(() => setCookie('soon')).toThrow(/Cannot read "soon" as a cookie maxAge/)
  })
})

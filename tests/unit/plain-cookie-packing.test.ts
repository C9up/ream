/**
 * AdonisJS packs a plain cookie into a base64url JSON envelope, which is what
 * lets `plainCookie('prefs', { theme: 'dark' })` come back an OBJECT. ream took
 * a string and URL-encoded it, so every value returned a string — and an object
 * arrived as "[object Object]".
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'
import { Response as ReamResponse } from '../../src/http/Response.js'
import { defined } from '../__helpers__/defined.js'

/** Set a cookie on a response, then read it back through a request. */
function roundTrip<T>(value: T, options?: { encode?: boolean }): unknown {
  const res = new ReamResponse()
  res.plainCookie('prefs', value, options)
  const setCookie = res.getHeaders()['set-cookie'] ?? ''
  const raw = decodeURIComponent(defined(setCookie.split(';')[0]).split('=')[1] ?? '')
  const req = new Request(
    {
      method: 'GET',
      url: '/',
      path: '/',
      headers: {},
      cookies: { prefs: raw },
      body: '',
    } as never,
    {},
  )
  return req.plainCookie('prefs')
}

describe('ream > plain cookie packing', () => {
  it('round-trips an object', () => {
    expect(roundTrip({ theme: 'dark', density: 2 })).toEqual({
      theme: 'dark',
      density: 2,
    })
  })

  it('keeps the type of a number and a boolean', () => {
    expect(roundTrip(42)).toBe(42)
    expect(roundTrip(true)).toBe(true)
  })

  it('round-trips a plain string', () => {
    expect(roundTrip('dark')).toBe('dark')
  })

  it('writes the value verbatim under encode: false', () => {
    const res = new ReamResponse()
    res.plainCookie('xsrf', 'token-abc', { encode: false })
    expect(res.getHeaders()['set-cookie'] ?? '').toContain('xsrf=token-abc')
  })

  it('reads a cookie set by something else as the raw string', () => {
    const req = new Request(
      {
        method: 'GET',
        url: '/',
        path: '/',
        headers: {},
        cookies: { third_party: 'not-an-envelope' },
        body: '',
      } as never,
      {},
    )
    expect(req.plainCookie('third_party')).toBe('not-an-envelope')
  })
})

/**
 * Cookie values were percent-encoded on write and never decoded on read, so a
 * plain cookie holding a space, an accent or a `;` did not round-trip.
 * AdonisJS (`@adonisjs/http-server` 9.3.1) serialises with cookie-es
 * `serialize` (encodeURIComponent) and parses with cookie-es `parse`, which
 * decodes a value holding a `%` and keeps it raw when the sequence is malformed.
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'
import { Response } from '../../src/http/Response.js'

/** The `name=value` pair the response wrote, as a browser sends it back. */
function writtenPair(response: Response): string {
  return (response.getHeaders()['set-cookie'] ?? '').split(';')[0] ?? ''
}

function incoming(pair: string, preParsed: boolean): Request {
  const eq = pair.indexOf('=')
  return new Request({
    method: 'GET',
    path: '/',
    query: '',
    headers: { cookie: pair },
    body: '',
    // What the native layer hands over: the `cookie` crate's `Cookie::parse`
    // splits the header but does not percent-decode.
    cookies: preParsed ? { [pair.slice(0, eq)]: pair.slice(eq + 1) } : undefined,
  })
}

describe('plain cookies > percent-encoding round trip', () => {
  for (const preParsed of [true, false]) {
    const source = preParsed ? 'the native cookie map' : 'the header fallback'

    it(`reads back what encode:false wrote, from ${source}`, () => {
      const response = new Response()
      response.plainCookie('theme', 'café noir; v=2', { encode: false })
      const pair = writtenPair(response)
      expect(pair).toBe('theme=caf%C3%A9%20noir%3B%20v%3D2')

      const request = incoming(pair, preParsed)
      expect(request.plainCookie('theme', undefined, { encoded: false })).toBe('café noir; v=2')
      expect(request.cookies()).toEqual({ theme: 'café noir; v=2' })
    })

    it(`keeps a malformed escape raw instead of throwing, from ${source}`, () => {
      const request = incoming('broken=100%zz', preParsed)
      expect(request.plainCookie('broken', undefined, { encoded: false })).toBe('100%zz')
    })
  }

  it('round-trips a packed plain cookie whose name needs encoding', () => {
    const response = new Response()
    response.plainCookie('my pref', { dark: true })
    const request = incoming(writtenPair(response), true)
    expect(request.plainCookie('my pref')).toEqual({ dark: true })
  })
})

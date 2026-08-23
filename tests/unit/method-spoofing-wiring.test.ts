/**
 * `setMethodSpoofing` existed but nothing ever called it, so an app that asked
 * for `_method` spoofing in config got a field that did nothing — the form
 * posted, the route never matched the DELETE it meant.
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'

/**
 * A JSON body, which `Request` parses on its own. A real HTML form sends
 * urlencoded and is decoded by BodyParserMiddleware first; what is under test
 * here is the spoofing decision, not the decoding.
 */
function post(body: Record<string, string>) {
  return new Request(
    {
      method: 'POST',
      url: '/posts/1',
      path: '/posts/1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } as never,
    {},
  )
}

describe('ream > _method spoofing', () => {
  it('is off unless asked for', () => {
    const request = post({ _method: 'DELETE' })
    expect(request.method()).toBe('POST')
    expect(request.intended()).toBe('POST')
  })

  it('rewrites the method once enabled', () => {
    const request = post({ _method: 'DELETE' })
    request.setMethodSpoofing(true)
    expect(request.method()).toBe('DELETE')
    // The real method stays visible, which is what routing uses.
    expect(request.intended()).toBe('POST')
  })

  it('only ever rewrites a POST', () => {
    const request = new Request(
      { method: 'GET', url: '/x', path: '/x', headers: {}, body: '' } as never,
      {},
    )
    request.setMethodSpoofing(true)
    expect(request.method()).toBe('GET')
  })
})

/**
 * `setMethodSpoofing` existed but nothing ever called it, so an app that asked
 * for `_method` spoofing in config got a field that did nothing — the form
 * posted, the route never matched the DELETE it meant.
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'

/** A POST whose query string and parsed body are given. */
function post(query: string, body: Record<string, string> = {}) {
  const request = new Request({
    method: 'POST',
    path: '/posts/1',
    query,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  request.setParsedBody(body)
  return request
}

describe('ream > _method spoofing', () => {
  it('is off unless asked for', () => {
    const request = post('_method=DELETE')
    expect(request.method()).toBe('POST')
    expect(request.intended()).toBe('POST')
  })

  it('rewrites the method once enabled', () => {
    const request = post('_method=DELETE')
    request.setMethodSpoofing(true)
    expect(request.method()).toBe('DELETE')
    // The real method stays visible.
    expect(request.intended()).toBe('POST')
  })

  it('ignores a _method in the body', () => {
    const request = post('', { _method: 'DELETE' })
    request.setMethodSpoofing(true)
    expect(request.method()).toBe('POST')
  })

  it('only ever rewrites a POST', () => {
    const request = new Request({
      method: 'GET',
      path: '/x',
      query: '_method=DELETE',
      headers: {},
      body: '',
    })
    request.setMethodSpoofing(true)
    expect(request.method()).toBe('GET')
  })
})

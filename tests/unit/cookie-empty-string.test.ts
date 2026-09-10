/**
 * An empty signed cookie is a value, not an absence.
 *
 * Upstream falls back with `||` (`@adonisjs/http-server@9.3.0`:
 * `return this.#cookieParser.unsign(key) || defaultValue`), so a cookie
 * someone deliberately wrote as `""` reads back as the default. Its own
 * doc-comment on that line says the default applies "when actual value is
 * undefined" — which is `??`, not `||`.
 *
 * `Response.cookie` takes `value: string`, so `""` is the ONE falsy value a
 * signed cookie can hold. That makes this the whole of the deviation, and the
 * reason it is worth having: a cleared preference, an intentionally blank
 * field, a form value the user emptied.
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'

const signer = new CookieSigner('a-sufficiently-long-app-key-for-tests')

/** A request carrying `name` as a properly signed cookie. */
function requestWithSignedCookie(name: string, value: string): Request {
  const signed = signer.sign(value, undefined, name)
  const request = new Request(
    {
      method: 'GET',
      path: '/',
      query: '',
      headers: { cookie: `${name}=${encodeURIComponent(signed)}` },
      body: '',
    },
    {},
  )
  request.setCookieSigner(signer)
  return request
}

describe('ream > request.cookie and the empty string', () => {
  it('hands back the empty string a signed cookie holds, not the fallback', () => {
    const request = requestWithSignedCookie('draft', '')
    expect(request.cookie('draft', 'fallback')).toBe('')
  })

  it('still hands back the fallback when the cookie is absent', () => {
    const request = requestWithSignedCookie('other', 'x')
    expect(request.cookie('draft', 'fallback')).toBe('fallback')
  })

  it('hands back the fallback when the signature does not verify', () => {
    // A tampered cookie is not a value someone wrote — it is an absence with
    // a lie attached, and the default is the safe answer.
    const request = new Request(
      {
        method: 'GET',
        path: '/',
        query: '',
        headers: { cookie: 'draft=not-a-signed-value' },
        body: '',
      },
      {},
    )
    request.setCookieSigner(signer)
    expect(request.cookie('draft', 'fallback')).toBe('fallback')
  })

  it('answers null, not the empty string, when absent with no fallback', () => {
    const request = requestWithSignedCookie('other', 'x')
    expect(request.cookie('draft')).toBeNull()
  })
})

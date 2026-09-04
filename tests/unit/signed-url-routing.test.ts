import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'
import { Router } from '../../src/router/Router.js'
import { SignedUrl } from '../../src/security/SignedUrl.js'

// Router.makeSignedUrl + Request.hasValidSignature are thin bindings over the
// existing SignedUrl helper — this covers the wiring, not the crypto (which
// SignedUrl's own suite already exercises).
const signedUrl = new SignedUrl({ secret: 'a'.repeat(32) })

function router(): Router {
  const r = new Router()
  r.get('/reset/:token', async () => {}).as('reset')
  r.setSignedUrl(signedUrl)
  return r
}

function requestFor(url: string, withSigner = true): Request {
  const [path = '', query = ''] = url.split('?')
  const req = new Request({ method: 'GET', path, query, headers: {}, body: '' })
  if (withSigner) req.setSignedUrl(signedUrl)
  return req
}

describe('router.makeSignedUrl + request.hasValidSignature (wiring)', () => {
  it('produces a signature that verifies', () => {
    const url = router().makeSignedUrl('reset', { token: 'abc' })
    expect(url).toContain('signature=')
    expect(requestFor(url).hasValidSignature()).toBe(true)
  })

  it('rejects a tampered path', () => {
    const url = router().makeSignedUrl('reset', { token: 'abc' })
    expect(requestFor(url.replace('/reset/abc', '/reset/xyz')).hasValidSignature()).toBe(false)
  })

  it('rejects a tampered extra query param', () => {
    const url = router().makeSignedUrl('reset', { token: 'abc' }, { qs: { role: 'user' } })
    expect(requestFor(url.replace('role=user', 'role=admin')).hasValidSignature()).toBe(false)
  })

  it('accepts a non-expired link and rejects an expired one', () => {
    expect(
      requestFor(
        router().makeSignedUrl('reset', { token: 'a' }, { expiresIn: 60 }),
      ).hasValidSignature(),
    ).toBe(true)
    expect(
      requestFor(
        router().makeSignedUrl('reset', { token: 'a' }, { expiresIn: -10 }),
      ).hasValidSignature(),
    ).toBe(false)
  })

  it('binds the signature to a purpose', () => {
    const url = router().makeSignedUrl('reset', { token: 'abc' }, { purpose: 'password-reset' })
    expect(requestFor(url).hasValidSignature('password-reset')).toBe(true)
    expect(requestFor(url).hasValidSignature('other')).toBe(false)
  })

  it('returns false without a signer or signature', () => {
    const url = router().makeSignedUrl('reset', { token: 'abc' })
    expect(requestFor(url, false).hasValidSignature()).toBe(false)
    expect(requestFor('/reset/abc').hasValidSignature()).toBe(false)
  })

  it('throws when no APP_KEY-backed signer is wired', () => {
    const r = new Router()
    r.get('/x', async () => {}).as('x')
    expect(() => r.makeSignedUrl('x')).toThrow(/E_MISSING_APP_KEY/)
  })
})

/**
 * What `serialize()` is allowed to put in a log line, and how a domain route
 * matches a host.
 */
import { describe, expect, it } from 'vitest'
import { Request } from '../../src/http/Request.js'

const request = (headers: Record<string, string>) =>
  new Request({ method: 'GET', path: '/orders', query: 'q=1', headers, body: '' }, {})

describe('Request.serializeSafe > credentials do not reach the log', () => {
  it('lists a credential header but not its value', () => {
    const serialized = request({
      authorization: 'Bearer sk_live_supersecret',
      cookie: 'session=abc',
      'x-api-key': 'k-live-1234',
      'user-agent': 'curl/8',
    }).serializeSafe()
    const headers = serialized.headers as Record<string, string>

    // Knowing the request carried an `authorization` header is most of what a
    // reader wants; its contents are none of it.
    expect(headers.authorization).toBe('[redacted]')
    expect(headers.cookie).toBe('[redacted]')
    expect(headers['x-api-key']).toBe('[redacted]')
    expect(JSON.stringify(serialized)).not.toContain('sk_live_supersecret')
    expect(JSON.stringify(serialized)).not.toContain('k-live-1234')
  })

  it('leaves every other header alone', () => {
    const headers = request({ 'user-agent': 'curl/8', accept: 'application/json' }).serializeSafe()
      .headers as Record<string, string>

    expect(headers['user-agent']).toBe('curl/8')
    expect(headers.accept).toBe('application/json')
  })

  it('redacts whatever case the header arrived in', () => {
    const headers = request({ Authorization: 'Bearer x' }).serializeSafe().headers as Record<
      string,
      string
    >

    expect(Object.values(headers)).toEqual(['[redacted]'])
  })

  it('still carries what a report is for', () => {
    const serialized = request({ host: 'acme.test' }).serializeSafe()

    expect(serialized.method).toBe('GET')
    expect(serialized.qs).toEqual({ q: '1' })
    expect(String(serialized.url)).toContain('/orders')
  })

  it('carries no body — the real values are still on headers()', () => {
    const req = request({ authorization: 'Bearer x' })

    expect(req.serializeSafe()).not.toHaveProperty('body')
    expect(req.headers().authorization).toBe('Bearer x')
  })
})

describe('CookieSigner > a key anyone can read is not a key', () => {
  it('refuses the placeholder the scaffolding used to ship', async () => {
    const { CookieSigner } = await import('../../src/security/CookieSigner.js')

    // With it, cookies, sessions, CSRF tokens and signed URLs can all be
    // forged by anyone who has read the repository.
    expect(() => new CookieSigner('change-me-to-a-unique-32+-byte-secret!!')).toThrow(/placeholder/)
  })

  it('refuses it whatever case or padding it arrives in', async () => {
    const { CookieSigner } = await import('../../src/security/CookieSigner.js')

    expect(() => new CookieSigner('  CHANGE-ME-TO-A-UNIQUE-32+-BYTE-SECRET!!  ')).toThrow(
      /placeholder/,
    )
  })

  it('still refuses an absent or too-short key', async () => {
    const { CookieSigner } = await import('../../src/security/CookieSigner.js')

    expect(() => new CookieSigner('')).toThrow(/Missing APP_KEY/)
    expect(() => new CookieSigner('short')).toThrow(/at least 16/)
  })

  it('accepts a real one', async () => {
    const { CookieSigner } = await import('../../src/security/CookieSigner.js')
    const { randomBytes } = await import('node:crypto')

    expect(() => new CookieSigner(randomBytes(32).toString('base64url'))).not.toThrow()
  })
})

describe('Request.serialize > the dump upstream reports', () => {
  it('carries the body, the cookies and the headers verbatim', () => {
    const req = new Request(
      {
        method: 'POST',
        path: '/login',
        query: 'next=/home',
        headers: { authorization: 'Bearer sk_live_x', cookie: 'session=abc' },
        body: '',
      },
      {},
    )

    const json = req.serialize()

    // Upstream's serialize() is a debugging dump, not a log-safe view. It is
    // the caller's job not to put it in a log line.
    expect(json.headers).toMatchObject({ authorization: 'Bearer sk_live_x' })
    expect(json).toHaveProperty('body')
    expect(json).toHaveProperty('cookies')
    expect(json.query).toBe('next=/home')
    expect(json.method).toBe('POST')
  })

  it('is what serializeSafe deliberately is not', () => {
    const req = new Request(
      {
        method: 'GET',
        path: '/x',
        query: '',
        headers: { authorization: 'Bearer sk_live_x' },
        body: '',
      },
      {},
    )

    expect(JSON.stringify(req.serialize())).toContain('sk_live_x')
    expect(JSON.stringify(req.serializeSafe())).not.toContain('sk_live_x')
  })
})

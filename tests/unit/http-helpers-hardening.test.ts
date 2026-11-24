/**
 * Three HTTP helpers held to upstream's checks: a relative redirect is judged
 * on the URL a browser parses, cookie `Path` and `Domain` follow the cookie
 * attribute grammar, and a JSONP body is never sniffed.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { Response } from '../../src/http/Response.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

describe('redirect().toIntended() > a stored URL a browser reads as another host', () => {
  async function landing(intended: string): Promise<string | undefined> {
    const ctx = new HttpContext(
      'test',
      { method: 'POST', path: '/login', query: '', headers: { host: 'app.test' }, body: '' },
      {},
      { pattern: '/login', middleware: [] },
    )
    ctx.setCookieSigner(new CookieSigner('test-app-key-32-bytes-long-xxxxxx'))
    await new SessionMiddleware({ store: 'memory', cookieName: 's', maxAge: 3600 }).handle(
      ctx,
      async () => {
        ctx.session?.setIntendedUrl(intended)
        ctx.response.redirect().toIntended('/home')
      },
    )
    return ctx.response.getHeader('location')
  }

  it('falls back for a path the URL parser turns protocol-relative', async () => {
    for (const intended of [
      '/\t/evil.test/login',
      '/\n/evil.test',
      '/\r/evil.test',
      '/\\evil.test',
      '//evil.test',
      '/\\/evil.test',
    ]) {
      expect(await landing(intended), JSON.stringify(intended)).toBe('/home')
    }
  })

  it('keeps an ordinary relative path', async () => {
    expect(await landing('/dashboard?tab=1')).toBe('/dashboard?tab=1')
  })
})

describe('response cookies > Path and Domain grammar', () => {
  it('refuses a path or a domain that would inject attributes or split the header', () => {
    const bad = [
      { path: '/; SameSite=None' },
      { path: '/\r\nX-Evil: 1' },
      { path: '/\u0000' },
      { path: '/café' },
      { domain: 'app.test; Secure' },
      { domain: 'app test' },
      { domain: 'app.test\r\n' },
      { domain: '-app.test' },
    ]
    for (const options of bad) {
      expect(
        () => new Response().plainCookie('theme', 'dark', options),
        JSON.stringify(options),
      ).toThrow(expect.objectContaining({ code: 'E_RESPONSE_INVALID_COOKIE' }))
    }
  })

  it('writes a valid path and domain as given', () => {
    const response = new Response()
    response.plainCookie('theme', 'dark', {
      path: '/admin panel',
      domain: '.app.test',
      encode: false,
    })
    expect(response.getHeaders()['set-cookie']).toContain('Path=/admin panel; Domain=.app.test')
  })
})

describe('response.jsonp()', () => {
  it('sends X-Content-Type-Options: nosniff', () => {
    const response = new Response()
    response.jsonp({ ok: true })
    expect(response.getHeader('x-content-type-options')).toBe('nosniff')
  })
})

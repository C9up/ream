/**
 * Every cookie a response writes gets the application's cookie defaults
 * (`http.cookie`, over `maxAge: '2h'`, `path: '/'`, `httpOnly`, `secure`,
 * `sameSite: 'lax'`), and a call overrides them. Before, a cookie written
 * without options carried `HttpOnly` only: no `Secure`, so it also travelled
 * over plain HTTP.
 */
import { describe, expect, it } from 'vitest'
import {
  cookieDefaultsFromConfig,
  DEFAULT_COOKIE_OPTIONS,
  Response,
} from '../../src/http/Response.js'
import { createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'

function attributes(line: string): string[] {
  return line.split('; ').slice(1)
}

function lines(response: Response): string[] {
  return (response.getHeaders()['set-cookie'] ?? '').split('\n')
}

describe('response cookies > defaults', () => {
  it('cookie(), encryptedCookie() and plainCookie() carry the defaults', () => {
    const response = new Response()
    response.setCookieSigner(new CookieSigner('a-test-app-key-of-32-bytes-long!!'))
    response.cookie('remember_me', 'token')
    response.encryptedCookie('cart', 'secret')
    response.plainCookie('prefs', { theme: 'dark' })
    for (const line of lines(response)) {
      expect(attributes(line)).toEqual([
        'Max-Age=7200',
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=lax',
      ])
    }
  })

  it('a call overrides a default, and an explicit undefined drops it', () => {
    const response = new Response()
    response.plainCookie('a', '1', {
      secure: false,
      sameSite: 'strict',
      httpOnly: false,
      maxAge: undefined,
    })
    expect(attributes(lines(response)[0] ?? '')).toEqual(['Path=/', 'SameSite=strict'])
  })

  it('clearCookie() expires the cookie on the default path, with the defaults', () => {
    const response = new Response()
    response.clearCookie('a')
    const cleared = lines(response)[0] ?? ''
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('Path=/')
    expect(cleared).toContain('Secure')
  })

  it('the application defaults replace the framework ones, key by key', () => {
    const response = new Response()
    response.setCookieDefaults(
      cookieDefaultsFromConfig({ secure: false, maxAge: '1h', domain: 'app.test' }),
    )
    response.plainCookie('a', '1')
    expect(attributes(lines(response)[0] ?? '')).toEqual([
      'Max-Age=3600',
      'Path=/',
      'Domain=app.test',
      'HttpOnly',
      'SameSite=lax',
    ])
  })
})

describe('cookieDefaultsFromConfig', () => {
  it('is the framework defaults without a block', () => {
    expect(cookieDefaultsFromConfig(undefined)).toEqual(DEFAULT_COOKIE_OPTIONS)
    expect(cookieDefaultsFromConfig({ path: undefined })).toEqual(DEFAULT_COOKIE_OPTIONS)
  })

  it('refuses an unknown key, a value of the wrong type and a block that is not an object', () => {
    for (const block of [
      { samesite: 'lax' },
      { secure: 'false' },
      { sameSite: true },
      { maxAge: null },
      'lax',
      [],
    ]) {
      expect(() => cookieDefaultsFromConfig(block), JSON.stringify(block)).toThrow(
        expect.objectContaining({ code: 'E_RESPONSE_INVALID_COOKIE' }),
      )
    }
  })
})

describe('the kernel hands the application defaults to every response', () => {
  it('applies `cookie` from the kernel config', async () => {
    const router = new Router()
    router.get('/', (ctx) => {
      ctx.response.plainCookie('a', '1')
      ctx.response.send('ok')
    })
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      cookie: cookieDefaultsFromConfig({ sameSite: 'strict' }),
    })
    const res = await kernel({
      method: 'GET',
      path: '/',
      query: '',
      headers: { host: 'app.test' },
      body: '',
    })
    expect(String(res.headers['set-cookie'])).toContain('SameSite=strict')
    expect(String(res.headers['set-cookie'])).toContain('Secure')
  })
})

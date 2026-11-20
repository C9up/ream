/**
 * `redirect().withIntendedUrl()` and `toIntended()` were built without the
 * session, so the intended URL was never stored and login always landed on
 * the fallback. Upstream, `@adonisjs/session` adds both as Redirect macros
 * reading `this.ctx.session`.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'

const signer = new CookieSigner('test-app-key-32-bytes-long-xxxxxx')

function request(
  method: string,
  path: string,
  options: { cookie?: string; headers?: Record<string, string>; pattern?: string } = {},
): HttpContext {
  const headers: Record<string, string> = { host: 'app.test', ...options.headers }
  if (options.cookie) headers.cookie = options.cookie
  const ctx = new HttpContext(
    'test',
    { method, path, query: '', headers, body: '' },
    {},
    { pattern: options.pattern ?? path, middleware: [] },
  )
  ctx.setCookieSigner(signer)
  return ctx
}

/** The `name=value` pair of the session cookie the response set, for the next request. */
function sessionCookie(ctx: HttpContext): string | undefined {
  const header = ctx.response.getHeaders()['set-cookie'] ?? ''
  return header
    .split('\n')
    .map((line) => line.split(';')[0] ?? '')
    .find((pair) => pair.startsWith('ream_session='))
}

function sessions(): SessionMiddleware {
  return new SessionMiddleware({ store: 'memory', cookieName: 'ream_session', maxAge: 3600 })
}

describe('redirect().withIntendedUrl() / toIntended() > through the session middleware', () => {
  it('stores the intended URL and redirects to it after login', async () => {
    const middleware = sessions()

    const guarded = request('GET', '/dashboard')
    await middleware.handle(guarded, async () => {
      guarded.response.redirect().withIntendedUrl().toPath('/login')
    })
    expect(guarded.session?.getIntendedUrl()).toBe('/dashboard')
    const cookie = sessionCookie(guarded)
    expect(cookie).toBeDefined()

    const login = request('POST', '/login', { cookie })
    await middleware.handle(login, async () => {
      login.response.redirect().toIntended('/')
    })
    expect(login.response.getHeader('location')).toBe('/dashboard')
    // Pulled: a second login lands on the fallback.
    expect(login.session?.getIntendedUrl()).toBeNull()
  })

  it('does not store the URL of a non-GET request', async () => {
    const post = request('POST', '/posts')
    await sessions().handle(post, async () => {
      post.response.redirect().withIntendedUrl().toPath('/login')
    })
    expect(post.session?.getIntendedUrl()).toBeNull()
  })

  it('does not store the URL of an XHR', async () => {
    const xhr = request('GET', '/dashboard', { headers: { 'x-requested-with': 'XMLHttpRequest' } })
    await sessions().handle(xhr, async () => {
      xhr.response.redirect().withIntendedUrl().toPath('/login')
    })
    expect(xhr.session?.getIntendedUrl()).toBeNull()
  })

  it('does not store the URL of a request no route matched', async () => {
    const notFound = request('GET', '/nowhere', { pattern: '' })
    await sessions().handle(notFound, async () => {
      notFound.response.redirect().withIntendedUrl().toPath('/login')
    })
    expect(notFound.session?.getIntendedUrl()).toBeNull()
  })
})

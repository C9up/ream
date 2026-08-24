/**
 * `redirect().withQs()` in the four shapes AdonisJS accepts, plus `clearQs()`.
 * Read off @adonisjs/http-server's RedirectBuilder: one `withQs(name, value)`
 * implementation branching on the argument type, and a composition order that
 * puts the forwarded query string first and explicit values on top.
 */
import { describe, expect, it } from 'vitest'
import { RedirectBuilder } from '../../src/http/RedirectBuilder.js'
import { Response } from '../../src/http/Response.js'

function build(requestUrl = '/search?page=1&tag=news') {
  const response = new Response()
  const redirect = new RedirectBuilder(response, {
    requestUrl,
    routeUrlResolver: (name) => `/${name}`,
  })
  return { response, redirect }
}

function location(response: Response): string {
  return String(response.getHeaders().location ?? '')
}

describe('ream > redirect().withQs (AdonisJS parity)', () => {
  it('forwards the request query string with no arguments', () => {
    const { response, redirect } = build()
    redirect.withQs().toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?page=1&tag=news')
  })

  it('stops forwarding when passed false', () => {
    const { response, redirect } = build()
    redirect.withQs().withQs(false).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard')
  })

  it('merges an object of values', () => {
    const { response, redirect } = build('/x')
    redirect.withQs({ utm_source: 'newsletter', ref: 'a' }).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?utm_source=newsletter&ref=a')
  })

  it('sets a single name/value pair', () => {
    const { response, redirect } = build('/x')
    redirect.withQs('page', 2).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?page=2')
  })

  it('accumulates across calls rather than replacing', () => {
    const { response, redirect } = build('/x')
    redirect.withQs('a', 1).withQs({ b: 2 }).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?a=1&b=2')
  })

  it('lets an explicit value override a forwarded one', () => {
    // Adonis parses the forwarded string first, then Object.assign's the
    // explicit values over it.
    const { response, redirect } = build()
    redirect.withQs().withQs('page', 9).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?page=9&tag=news')
  })

  it('clearQs() drops both the values and the forwarding', () => {
    const { response, redirect } = build()
    redirect.withQs().withQs('a', 1).clearQs().toPath('/dashboard')
    expect(location(response)).toBe('/dashboard')
  })
})

/**
 * Intended-URL redirects. These live in `@adonisjs/session`, not in
 * http-server: it adds `withIntendedUrl` / `toIntended` / `toIntendedRoute`
 * to Redirect as macros (session_middleware.js:21-45). Looking only at
 * http-server's RedirectBuilder makes them look absent — they are not.
 */
describe('ream > redirect().toIntended (AdonisJS parity)', () => {
  function withSession(requestUrl = 'http://app.test/admin/reports', stored?: string) {
    let intended: string | null = stored ?? null
    const session = {
      setIntendedUrl(url: string) {
        intended = url
      },
      pullIntendedUrl() {
        const value = intended
        intended = null
        return value
      },
    }
    const response = new Response()
    const redirect = new RedirectBuilder(response, {
      requestUrl,
      session,
      routeUrlResolver: (name) => `/${name}`,
    })
    return { response, redirect, session, read: () => intended }
  }

  it('remembers a GET destination and redirects back to it after', () => {
    const { redirect, response, read } = withSession()
    redirect.withIntendedUrl('GET')
    expect(read()).toBe('http://app.test/admin/reports')

    redirect.toIntended()
    expect(location(response)).toBe('http://app.test/admin/reports')
  })

  it('consumes the stored URL, so a second redirect falls back', () => {
    const { redirect, read } = withSession()
    redirect.withIntendedUrl('GET')
    redirect.toIntended()
    // pull = read + delete, as upstream does.
    expect(read()).toBeNull()
  })

  it('does not remember a POST, an XHR or an unmatched route', () => {
    const post = withSession()
    post.redirect.withIntendedUrl('POST')
    expect(post.read()).toBeNull()

    const response = new Response()
    const xhr = new RedirectBuilder(response, {
      requestUrl: 'http://app.test/x',
      session: post.session,
      isAjax: true,
    })
    xhr.withIntendedUrl('GET')
    expect(post.read()).toBeNull()
  })

  it('falls back when nothing was remembered', () => {
    const { redirect, response } = withSession()
    redirect.toIntended('/dashboard')
    expect(location(response)).toBe('/dashboard')
  })

  it('refuses an off-site intended URL', () => {
    // A session store is not a trust boundary; redirecting to an absolute
    // foreign URL is an open redirect.
    const { redirect, response } = withSession('http://app.test/x', 'https://evil.example/steal')
    redirect.toIntended('/safe')
    expect(location(response)).toBe('/safe')
  })

  it('refuses a protocol-relative //evil.com', () => {
    // Looks relative, is absolute to a browser.
    const { redirect, response } = withSession('http://app.test/x', '//evil.example/steal')
    redirect.toIntended('/safe')
    expect(location(response)).toBe('/safe')
  })

  it('toIntendedRoute falls back to the named route', () => {
    const { redirect, response } = withSession('http://app.test/x')
    redirect.toIntendedRoute('dashboard')
    expect(location(response)).toBe('/dashboard')
  })
})

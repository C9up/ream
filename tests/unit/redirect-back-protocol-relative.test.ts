/**
 * `redirect().back()` validated the HOST of an absolute Referer and then wrote
 * only its PATH to Location. A same-host Referer whose path starts with `//`
 * (`http://app.test//evil.com/x`) therefore became the protocol-relative
 * `//evil.com/x` — an open redirect. `request.getPreviousUrl()` did the same.
 * Both keep answering with a path (the site never sends the user off-site),
 * but one that can only resolve against the current origin.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'

function ctxWith(referer: string): HttpContext {
  return new HttpContext(
    'test',
    { method: 'POST', path: '/form', query: '', headers: { host: 'app.test', referer }, body: '' },
    {},
    { pattern: '/form', middleware: [] },
  )
}

const PROTOCOL_RELATIVE_REFERERS = [
  'http://app.test//evil.com/x',
  'http://app.test/\\evil.com/x',
  'http://app.test///evil.com',
  'http://app.test/\\/evil.com',
]

/** Where a browser on app.test goes when it follows `location`. */
function resolvedHost(location: string): string {
  return new URL(location, 'http://app.test/').host
}

describe('redirect().back() > a same-host Referer whose path looks protocol-relative', () => {
  it('never writes a Location that leaves the host', () => {
    for (const referer of PROTOCOL_RELATIVE_REFERERS) {
      const ctx = ctxWith(referer)
      ctx.response.redirect().back()
      const location = ctx.response.getHeader('location') ?? ''

      expect(location.startsWith('//')).toBe(false)
      expect(resolvedHost(location)).toBe('app.test')
    }
  })

  it('keeps the rest of the path, and forwards the query string through withQs()', () => {
    const ctx = ctxWith('http://app.test//evil.com/x?q=1')
    ctx.response.redirect().withQs().back()

    expect(ctx.response.getHeader('location')).toBe('/evil.com/x?q=1')
  })

  it('leaves an ordinary Referer path as it was', () => {
    const ctx = ctxWith('http://app.test/posts/1')
    ctx.response.redirect().back()

    expect(ctx.response.getHeader('location')).toBe('/posts/1')
  })
})

describe('request.getPreviousUrl() > a same-host Referer whose path looks protocol-relative', () => {
  it('returns a path that stays on the host', () => {
    for (const referer of PROTOCOL_RELATIVE_REFERERS) {
      const previous = ctxWith(referer).request.getPreviousUrl()

      expect(previous.startsWith('//')).toBe(false)
      expect(resolvedHost(previous)).toBe('app.test')
    }
  })

  it('keeps the query string', () => {
    expect(ctxWith('http://app.test//evil.com/x?q=1').request.getPreviousUrl()).toBe(
      '/evil.com/x?q=1',
    )
  })
})

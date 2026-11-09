import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { RedirectBuilder } from '../../src/http/RedirectBuilder.js'

interface ResponseSpy {
  status: number | undefined
  headers: Record<string, string>
  body: string | undefined
}

function makeResponseFake() {
  const spy: ResponseSpy = { status: undefined, headers: {}, body: undefined }
  const response = {
    status(code: number) {
      spy.status = code
      return response
    },
    header(name: string, value: string) {
      spy.headers[name] = value
      return response
    },
    setBody(body: string) {
      spy.body = body
    },
  } as unknown as ConstructorParameters<typeof RedirectBuilder>[0]
  return { response, spy }
}

describe('ream > RedirectBuilder > toPath', () => {
  it('writes default 302 status, location header, and empty body', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response).toPath('/login')
    expect(spy.status).toBe(302)
    expect(spy.headers.location).toBe('/login')
    expect(spy.body).toBe('')
  })

  it('respects an explicit status() override', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response).status(301).toPath('/permanent')
    expect(spy.status).toBe(301)
  })

  it('appends an explicit query string via withQs(qs)', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response).withQs({ page: '2', sort: 'asc' }).toPath('/results')
    expect(spy.headers.location).toBe('/results?page=2&sort=asc')
  })

  it('appends `&qs` when target already has a `?`', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response).withQs({ page: '2' }).toPath('/r?ref=foo')
    expect(spy.headers.location).toBe('/r?ref=foo&page=2')
  })

  it('forwards request query string when withQs() is called without args', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response, { requestUrl: '/old?a=1&b=2' }).withQs().toPath('/new')
    expect(spy.headers.location).toBe('/new?a=1&b=2')
  })

  it('returns the raw path when requestUrl has no query and forwardQs is set', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response, { requestUrl: '/old' }).withQs().toPath('/new')
    expect(spy.headers.location).toBe('/new')
  })
})

describe('ream > RedirectBuilder > toRoute', () => {
  it('resolves the named route via routeUrlResolver', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response, {
      routeUrlResolver: (name, params) => `/named/${name}/${params?.id}`,
    }).toRoute('show', { id: '42' })
    expect(spy.headers.location).toBe('/named/show/42')
  })

  it('throws when no resolver was configured', () => {
    const { response } = makeResponseFake()
    expect(() => new RedirectBuilder(response).toRoute('show')).toThrow(
      /Route URL resolver not configured/,
    )
  })
})

describe('ream > RedirectBuilder > back', () => {
  it('uses the Referer when present', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response, { requestReferer: '/from' }).back()
    expect(spy.headers.location).toBe('/from')
  })

  it('falls back to the provided default when no Referer is set', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response).back('/home')
    expect(spy.headers.location).toBe('/home')
  })

  it('defaults the fallback to "/" when neither Referer nor explicit fallback exists', () => {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response).back()
    expect(spy.headers.location).toBe('/')
  })

  it('rejects a backslash Referer (open-redirect: "\\" normalises to "/") and uses the fallback', () => {
    const { response, spy } = makeResponseFake()
    // "/\\evil.com" starts with a single "/" but browsers normalise "\" → "/",
    // turning it into the protocol-relative "//evil.com". Must not be trusted.
    new RedirectBuilder(response, { requestReferer: '/\\evil.com' }).back('/safe')
    expect(spy.headers.location).toBe('/safe')
  })
})

describe('ream > RedirectBuilder > back with an absolute Referer (bug 523)', () => {
  function backFrom(
    referer: string,
    authority?: string,
    fallback = '/fallback',
  ): string | undefined {
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response, {
      requestUrl: '/save',
      requestReferer: referer,
      requestAuthority: authority,
    }).back(fallback)
    return spy.headers.location
  }

  it('goes back to the path of a Referer on the request authority, as browsers send it', () => {
    expect(backFrom('https://app.test/admin/users', 'app.test')).toBe('/admin/users')
  })

  it('compares the host with its port', () => {
    expect(backFrom('http://localhost:3333/form', 'localhost:3333')).toBe('/form')
    expect(backFrom('http://localhost:4444/form', 'localhost:3333')).toBe('/fallback')
  })

  it('drops the Referer query string unless withQs() forwards it', () => {
    expect(backFrom('https://app.test/list?page=3', 'app.test')).toBe('/list')
    const { response, spy } = makeResponseFake()
    new RedirectBuilder(response, {
      requestUrl: '/save?ignored=1',
      requestReferer: 'https://app.test/list?page=3',
      requestAuthority: 'app.test',
    })
      .withQs()
      .withQs('flash', 'ok')
      .back()
    expect(spy.headers.location).toBe('/list?page=3&flash=ok')
  })

  it('refuses a foreign host, and an absolute Referer when no authority is known', () => {
    expect(backFrom('https://evil.test/steal', 'app.test')).toBe('/fallback')
    expect(backFrom('https://app.test/admin', undefined)).toBe('/fallback')
  })

  it('never lets the redirect leave the site, even through an allowed host', () => {
    const { response, spy } = makeResponseFake()
    const redirect = new RedirectBuilder(response, {
      requestReferer: 'https://sso.test/done',
      requestAuthority: 'app.test',
    })
    redirect.allowedHosts = ['sso.test']
    redirect.back()
    expect(spy.headers.location).toBe('/done')
  })
})

describe('ream > HttpContext wires back() and withQs() to the real request (bug 523)', () => {
  function contextFor(path: string, query: string, headers: Record<string, string>): HttpContext {
    return new HttpContext(
      'req-1',
      { method: 'POST', path, query, headers, body: '' },
      {},
      { pattern: path, middleware: [] },
    )
  }

  it('back() follows a same-host absolute Referer', () => {
    const ctx = contextFor('/users', '', {
      host: 'app.test',
      referer: 'https://app.test/users/new',
    })
    ctx.response.redirect().back()
    expect(ctx.response.getHeader('location')).toBe('/users/new')
  })

  it('back() ignores X-Forwarded-Host when validating the Referer', () => {
    const ctx = contextFor('/users', '', {
      host: 'app.test',
      'x-forwarded-host': 'evil.test',
      referer: 'https://evil.test/phish',
    })
    ctx.response.redirect().back('/home')
    expect(ctx.response.getHeader('location')).toBe('/home')
  })

  it('withQs() forwards the current request query on toPath()', () => {
    const ctx = contextFor('/search', 'q=ream&page=2', { host: 'app.test' })
    ctx.response.redirect().withQs().toPath('/results')
    expect(ctx.response.getHeader('location')).toBe('/results?q=ream&page=2')
  })
})

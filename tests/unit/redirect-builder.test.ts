import { describe, expect, it } from 'vitest'
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

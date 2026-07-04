import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E_HTTP_REQUEST_ABORTED } from '../../src/http/Exception.js'
import { Response } from '../../src/http/Response.js'

describe('ream > Response.send() / json() — AdonisJS parity', () => {
  it('serves a plain string as text/plain and an HTML-looking string as text/html', () => {
    const plain = new Response()
    plain.send('This is the homepage.')
    expect(plain.getHeader('content-type')).toBe('text/plain; charset=utf-8')
    expect(plain.getBody()).toBe('This is the homepage.')

    const html = new Response()
    html.send('<p>Welcome</p>')
    expect(html.getHeader('content-type')).toBe('text/html; charset=utf-8')
    expect(html.getBody()).toBe('<p>Welcome</p>')
  })

  it('an explicitly set content-type wins over auto-detection', () => {
    const r = new Response()
    r.header('content-type', 'text/plain; charset=utf-8')
    r.send('<still plain>')
    expect(r.getHeader('content-type')).toBe('text/plain; charset=utf-8')
    expect(r.getBody()).toBe('<still plain>')
  })

  it('safe-stringifies BigInt in json() (native JSON.stringify throws)', () => {
    const r = new Response()
    r.json({ id: 9007199254740993n })
    expect(r.getHeader('content-type')).toBe('application/json')
    expect(JSON.parse(r.getBody())).toEqual({ id: '9007199254740993' })
  })

  it('drops circular references in an object send() instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const r = new Response()
    expect(() => r.send(cyclic)).not.toThrow()
    const parsed = JSON.parse(r.getBody())
    expect(parsed.name).toBe('x')
    expect(parsed.self).toBeUndefined()
  })
})

describe('ream > Response.type() — AdonisJS parity (mime-types)', () => {
  it('resolves a file extension to a full content-type with charset', () => {
    expect(new Response().type('txt').getHeader('content-type')).toBe('text/plain; charset=utf-8')
    expect(new Response().type('json').getHeader('content-type')).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('adds the default charset to a bare text MIME type', () => {
    expect(new Response().type('text/html').getHeader('content-type')).toBe(
      'text/html; charset=utf-8',
    )
  })

  it('appends an explicit charset passed as the second argument', () => {
    expect(new Response().type('application/json', 'utf-8').getHeader('content-type')).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('leaves a binary MIME type without a charset', () => {
    expect(new Response().type('image/png').getHeader('content-type')).toBe('image/png')
  })

  it('passes a full content-type (charset already inline) through unchanged', () => {
    expect(new Response().type('text/plain; charset=utf-8').getHeader('content-type')).toBe(
      'text/plain; charset=utf-8',
    )
  })
})

describe('ream > Response descriptive status methods (AdonisJS parity)', () => {
  it('sets the status and (optional) body', () => {
    const nf = new Response()
    nf.notFound('nope')
    expect(nf.getStatus()).toBe(404)
    expect(nf.getBody()).toBe('nope')

    const ok = new Response()
    ok.ok({ a: 1 })
    expect(ok.getStatus()).toBe(200)
    expect(ok.getHeader('content-type')).toBe('application/json')
    expect(JSON.parse(ok.getBody())).toEqual({ a: 1 })

    const un = new Response()
    un.unauthorized()
    expect(un.getStatus()).toBe(401)
  })

  it('covers the full 4xx/5xx range', () => {
    const cases: Array<[keyof Response, number]> = [
      ['badRequest', 400],
      ['forbidden', 403],
      ['conflict', 409],
      ['unprocessableEntity', 422],
      ['tooManyRequests', 429],
      ['internalServerError', 500],
      ['serviceUnavailable', 503],
    ]
    for (const [method, code] of cases) {
      const r = new Response()
      ;(r[method] as (b?: unknown) => void)()
      expect(r.getStatus()).toBe(code)
    }
  })
})

describe('ream > Response header/cookie/jsonp helpers (AdonisJS parity)', () => {
  it('safeHeader only sets when absent', () => {
    const r = new Response()
    r.safeHeader('x-a', 'first')
    r.safeHeader('x-a', 'second')
    expect(r.getHeader('x-a')).toBe('first')
  })

  it('vary appends and de-duplicates', () => {
    const r = new Response()
    r.vary('Accept')
    r.vary('Accept')
    r.vary(['Origin', 'Accept-Encoding'])
    expect(r.getHeader('vary')).toBe('Accept, Origin, Accept-Encoding')
  })

  it('location sets the Location header without redirecting', () => {
    const r = new Response()
    r.location('/dashboard')
    expect(r.getHeader('location')).toBe('/dashboard')
    expect(r.getStatus()).toBe(200)
  })

  it('clearCookie expires the cookie (Max-Age=0)', () => {
    const r = new Response()
    r.clearCookie('sid')
    const setCookie = r.getHeaders()['set-cookie'] ?? ''
    expect(setCookie).toContain('sid=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('jsonp wraps the body in the (sanitised) callback as text/javascript', () => {
    const r = new Response()
    r.jsonp({ a: 1 }, 'onData')
    expect(r.getHeader('content-type')).toBe('text/javascript; charset=utf-8')
    expect(r.getBody()).toContain('onData({"a":1})')

    const evil = new Response()
    evil.jsonp({}, 'alert(1)//')
    // parens/slashes stripped — no script injection through the callback name.
    expect(evil.getBody()).not.toContain('alert(1)')
    expect(evil.getBody()).toContain('alert1')
  })
})

describe('ream > Response file / caching / abort (AdonisJS parity)', () => {
  it('setEtag sets a strong or weak ETag', () => {
    const strong = new Response()
    strong.setEtag('hello')
    expect(strong.getHeader('etag')).toMatch(/^"[^"]+"$/)

    const weak = new Response()
    weak.setEtag('hello', true)
    expect(weak.getHeader('etag')).toMatch(/^W\/"/)
  })

  it('fresh() is true only for a cacheable request whose If-None-Match matches', () => {
    const r = new Response()
    r.setEtag('body')
    const tag = r.getHeader('etag') ?? ''

    r.setRequest({ method: () => 'GET', header: () => tag })
    expect(r.fresh()).toBe(true)

    r.setRequest({ method: () => 'GET', header: () => '"other"' })
    expect(r.fresh()).toBe(false)

    r.setRequest({ method: () => 'POST', header: () => tag })
    expect(r.fresh()).toBe(false)
  })

  it('abort throws E_HTTP_REQUEST_ABORTED carrying the body + status', () => {
    expect(() => new Response().abort('nope', 400)).toThrow(E_HTTP_REQUEST_ABORTED)
    let caught: unknown
    try {
      new Response().abort({ error: 'x' }, 422)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(E_HTTP_REQUEST_ABORTED)
    if (caught instanceof E_HTTP_REQUEST_ABORTED) {
      expect(caught.status).toBe(422)
      expect(caught.body).toEqual({ error: 'x' })
    }
  })

  it('abortIf only aborts when the condition is truthy', () => {
    expect(() => new Response().abortIf(true, 'x')).toThrow(E_HTTP_REQUEST_ABORTED)
    expect(() => new Response().abortIf(false, 'x')).not.toThrow()
    expect(() => new Response().abortIf(0, 'x')).not.toThrow()
  })

  it('download sends a file as a binary body with the right content-type', () => {
    const file = join(tmpdir(), 'ream-download-test.txt')
    writeFileSync(file, 'hello file')
    try {
      const r = new Response()
      r.download(file)
      expect(r.getHeader('content-type')).toBe('text/plain; charset=utf-8')
      expect(r.getHeader('x-ream-body-encoding')).toBe('base64')
      expect(Buffer.from(r.getBody(), 'base64').toString()).toBe('hello file')
    } finally {
      rmSync(file)
    }
  })

  it('attachment adds a Content-Disposition header', () => {
    const file = join(tmpdir(), 'ream-attach-test.txt')
    writeFileSync(file, 'x')
    try {
      const r = new Response()
      r.attachment(file, 'invoice.txt')
      expect(r.getHeader('content-disposition')).toBe('attachment; filename="invoice.txt"')
    } finally {
      rmSync(file)
    }
  })

  it('download of a missing file falls back to 404', () => {
    const r = new Response()
    r.download('/no/such/file-xyz.txt')
    expect(r.getStatus()).toBe(404)
  })
})

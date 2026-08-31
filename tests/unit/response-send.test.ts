import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E_HTTP_REQUEST_ABORTED } from '../../src/http/Exception.js'
import type { RawRequest } from '../../src/http/Request.js'
import { Request } from '../../src/http/Request.js'
import { Response } from '../../src/http/Response.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'

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

  it('download sends a file as a binary body with the right content-type', async () => {
    const file = join(tmpdir(), 'ream-download-test.txt')
    writeFileSync(file, 'hello file')
    try {
      const r = new Response()
      r.download(file)
      // The read is async now, parked on the same pending-body slot the kernel
      // awaits before serialising — it used to stall the event loop for every
      // other request while one client downloaded.
      await r.finish()
      expect(r.getHeader('content-type')).toBe('text/plain; charset=utf-8')
      expect(r.getHeader('x-ream-body-encoding')).toBe('base64')
      expect(Buffer.from(r.getBody(), 'base64').toString()).toBe('hello file')
    } finally {
      rmSync(file)
    }
  })

  it('attachment adds a Content-Disposition header', async () => {
    const file = join(tmpdir(), 'ream-attach-test.txt')
    writeFileSync(file, 'x')
    try {
      const r = new Response()
      r.attachment(file, 'invoice.txt')
      await r.finish()
      expect(r.getHeader('content-disposition')).toBe('attachment; filename="invoice.txt"')
    } finally {
      rmSync(file)
    }
  })

  it('download of a missing file falls back to 404', async () => {
    const r = new Response()
    r.download('/no/such/file-xyz.txt')
    await r.finish()
    expect(r.getStatus()).toBe(404)
  })

  it('download does not block the event loop while it reads', async () => {
    const file = join(tmpdir(), 'ream-download-async.txt')
    writeFileSync(file, 'x'.repeat(1024))
    try {
      const r = new Response()
      let tickRan = false
      r.download(file)
      // A macrotask scheduled AFTER the call still runs before the body lands:
      // with readFileSync it could not, because the read owned the thread.
      await new Promise((resolve) => setImmediate(resolve)).then(() => {
        tickRan = true
      })
      expect(tickRan).toBe(true)

      await r.finish()
      expect(Buffer.from(r.getBody(), 'base64')).toHaveLength(1024)
    } finally {
      rmSync(file)
    }
  })
})

describe('ream > Response/Request cookie signing (AdonisJS parity)', () => {
  const signer = new CookieSigner('test-app-key-32-bytes-long-xxxxxx')
  const rawWithCookie = (name: string, value: string): RawRequest => ({
    method: 'GET',
    path: '/',
    query: '',
    headers: { cookie: `${name}=${value}` },
    body: '',
  })

  it('cookie() signs by default; plainCookie() sends the raw value', () => {
    const signed = new Response()
    signed.setCookieSigner(signer)
    signed.cookie('sid', 'abc')
    const sc = signed.getHeaders()['set-cookie'] ?? ''
    expect(sc).toContain('sid=')
    expect(sc).not.toMatch(/sid=abc(;|$)/)

    // plainCookie is UNSIGNED but packed, as AdonisJS packs it — so the value
    // keeps its type on the way back. `encode: false` writes it verbatim.
    const plain = new Response()
    plain.setCookieSigner(signer)
    plain.plainCookie('sid', 'abc')
    const packed = plain.getHeaders()['set-cookie'] ?? ''
    expect(packed).not.toMatch(/sid=abc(;|$)/)

    const raw = new Response()
    raw.plainCookie('sid', 'abc', { encode: false })
    expect(raw.getHeaders()['set-cookie'] ?? '').toContain('sid=abc')
  })

  it('a signed cookie round-trips: response.cookie() → request.cookie()', () => {
    const res = new Response()
    res.setCookieSigner(signer)
    res.cookie('token', 'hello')
    const value = (res.getHeaders()['set-cookie'] ?? '').split(';')[0].slice('token='.length)

    const req = new Request(rawWithCookie('token', value), {})
    req.setCookieSigner(signer)
    expect(req.cookie('token')).toBe('hello')
    expect(req.plainCookie('token')).toBe(value)
  })

  it('request.cookie() returns null for a tampered signed cookie', () => {
    const req = new Request(
      rawWithCookie('token', `${signer.sign('hello', undefined, 'token')}X`),
      {},
    )
    req.setCookieSigner(signer)
    expect(req.cookie('token')).toBeNull()
  })

  it('a signed cookie moved to another name does not verify', () => {
    // The cookie's name is signed with its value, so lifting a value from a
    // harmless cookie into one the app trusts fails here instead of being
    // honoured under its new name.
    const res = new Response()
    res.setCookieSigner(signer)
    res.cookie('theme', 'dark')
    const value = (res.getHeaders()['set-cookie'] ?? '').split(';')[0].slice('theme='.length)

    const req = new Request(rawWithCookie('role', value), {})
    req.setCookieSigner(signer)
    expect(req.cookie('role')).toBeNull()
  })

  it('encryptedCookie() encrypts on write and decrypts on read', () => {
    const res = new Response()
    res.setCookieSigner(signer)
    res.encryptedCookie('secret', 'top')
    const sc = res.getHeaders()['set-cookie'] ?? ''
    expect(sc).not.toContain('top')
    const enc = sc.split(';')[0].split('=').slice(1).join('=')
    const req = new Request(rawWithCookie('secret', enc), {})
    req.setCookieSigner(signer)
    expect(req.encryptedCookie('secret')).toBe('top')
  })

  it('encryptedCookie() throws without an encryption service', () => {
    expect(() => new Response().encryptedCookie('x', 'y')).toThrow(/APP_KEY/)
  })

  it('cookie() refuses to write without APP_KEY rather than sending it plain', () => {
    // A silent fallback is the worst of both: the caller asked for integrity,
    // the value ships without it, and the far side reads whatever the client
    // wrote as though it had been verified.
    expect(() => new Response().cookie('sid', 'abc')).toThrow(/APP_KEY/)
  })

  it('request.cookie() answers nothing rather than an unverified value', () => {
    const req = new Request(rawWithCookie('sid', 'abc'), {})

    // No signer means nothing here was ever signed; handing the raw value
    // back would present the client's own input as verified.
    expect(req.cookie('sid')).toBeNull()
    expect(req.cookie('sid', 'fallback')).toBe('fallback')
    // The unsigned value is still reachable, explicitly.
    expect(req.plainCookie('sid', undefined, { encoded: false })).toBe('abc')
  })
})

describe('Response.jsonp default callback name', () => {
  it('defaults to `callback`, as AdonisJS does', () => {
    const res = new Response()
    res.jsonp({ a: 1 })
    expect(res.getBody()).toContain('callback({"a":1})')
  })

  it('honours the configured default (AdonisJS http.jsonpCallbackName)', () => {
    // The name used to be hardcoded, so a config asking for a different one
    // was ignored.
    const res = new Response()
    res.setJsonpCallbackName('cb')
    res.jsonp({ a: 1 })
    expect(res.getBody()).toContain('cb({"a":1})')
  })

  it('an explicit argument still wins over the configured default', () => {
    const res = new Response()
    res.setJsonpCallbackName('cb')
    res.jsonp({ a: 1 }, 'other')
    expect(res.getBody()).toContain('other({"a":1})')
  })

  it('sanitises the configured name too', () => {
    // The JSONP XSS guard must not depend on where the name came from.
    const res = new Response()
    res.setJsonpCallbackName('evil()<script>')
    res.jsonp({ a: 1 })
    expect(res.getBody()).not.toContain('<script>')
  })
})

describe('Response state getters (AdonisJS names)', () => {
  it('reports a pending response before anything is written', () => {
    const res = new Response()
    expect(res.isPending).toBe(true)
    expect(res.finished).toBe(false)
    expect(res.headersSent).toBe(false)
    expect(res.hasContent).toBe(false)
    expect(res.hasLazyBody).toBe(false)
  })

  it('reports content and completion once a body is sent', () => {
    const res = new Response()
    res.json({ a: 1 })

    // Only `isFinished()` existed, so a migrated `if (response.finished)` read
    // undefined and took the wrong branch without a word.
    expect(res.finished).toBe(true)
    expect(res.isFinished()).toBe(true)
    expect(res.hasContent).toBe(true)
    expect(res.hasLazyBody).toBe(true)
    expect(res.isPending).toBe(false)
  })

  it('an empty body is not content', () => {
    const res = new Response()
    res.status(204).send('')
    expect(res.hasContent).toBe(false)
  })
})

describe('Response.setRequestId (AdonisJS parity)', () => {
  it('echoes the caller‘s x-request-id back', () => {
    const res = new Response()
    res.setRequest({
      method: () => 'GET',
      header: (k: string) => (k === 'x-request-id' ? 'abc-123' : undefined),
    })

    // Ream already READ this header into ctx.id but never sent it back, so a
    // caller could not tie a response to the id it issued.
    res.setRequestId()
    expect(res.getHeader('x-request-id')).toBe('abc-123')
  })

  it('invents nothing when the caller sent none', () => {
    const res = new Response()
    res.setRequest({ method: () => 'GET', header: () => undefined })

    res.setRequestId()
    expect(res.getHeader('x-request-id')).toBeUndefined()
  })
})

describe('Response body ceiling', () => {
  it('accepts a body under the ceiling', () => {
    const res = new Response()
    res.setMaxBodyBytes(1024)
    expect(() => res.sendBuffer(Buffer.alloc(1024))).not.toThrow()
  })

  it('refuses one over it, naming the limit and the way out', () => {
    const res = new Response()
    res.setMaxBodyBytes(1024)

    // Without a ceiling a large file did not fail — it grew until the process
    // died, with nothing naming the cause.
    // The code is on the error, not spelled into its message: an application
    // deciding what to do with this matches on `code`.
    expect(() => res.sendBuffer(Buffer.alloc(2048))).toThrow(
      expect.objectContaining({ code: 'E_RESPONSE_TOO_LARGE' }),
    )
    expect(() => res.sendBuffer(Buffer.alloc(2048))).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('@c9up/archive') }),
    )
  })

  it('covers download too, since it goes through the same door', async () => {
    const file = join(tmpdir(), 'ream-ceiling-test.bin')
    writeFileSync(file, Buffer.alloc(4096))
    try {
      const res = new Response()
      res.setMaxBodyBytes(1024)
      res.download(file)

      await expect(res.finish()).rejects.toThrow(
        expect.objectContaining({ code: 'E_RESPONSE_TOO_LARGE' }),
      )
    } finally {
      rmSync(file)
    }
  })

  it('defaults to 100MB, matching the request side', () => {
    const res = new Response()
    // A modest body is never the thing that trips it.
    expect(() => res.sendBuffer(Buffer.alloc(1_048_576))).not.toThrow()
  })
})

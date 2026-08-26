import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function makeCtx(body: string, contentType: string): HttpContext {
  const raw: RawRequest = {
    method: 'POST',
    path: '/',
    query: '',
    // `content-length` the way a real request carries it: the middleware skips
    // a bodyless request, and hyper copies every header through verbatim.
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
    body,
  }
  return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
}

function makeCtxWith(
  body: string,
  contentType: string,
  overrides: Partial<RawRequest> & { headers?: Record<string, string> },
): HttpContext {
  const { headers, ...rest } = overrides
  const raw: RawRequest = {
    method: 'POST',
    path: '/',
    query: '',
    body,
    ...rest,
    // Merged last, and after `rest`, so an override adds a header rather than
    // replacing the whole map — dropping content-type here made the request
    // match no parser at all.
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      ...headers,
    },
  }
  return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
}

const noop = async () => {}

describe('BodyParserMiddleware — which requests get parsed', () => {
  it('leaves a GET body alone, whatever content-type it claims', async () => {
    // AdonisJS `allowedMethods` defaults to POST/PUT/PATCH/DELETE, so a GET
    // carrying a form body is passed through untouched.
    const ctx = makeCtxWith('a=1', 'application/x-www-form-urlencoded', { method: 'GET' })
    let nextCalled = false
    await new BodyParserMiddleware().handle(ctx, async () => {
      nextCalled = true
    })
    expect(ctx.request.body()).toEqual({})
    expect(nextCalled).toBe(true)
  })

  it('parses the methods AdonisJS whitelists', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const ctx = makeCtxWith('a=1', 'application/x-www-form-urlencoded', { method })
      await new BodyParserMiddleware().handle(ctx, noop)
      expect(ctx.request.body()).toEqual({ a: '1' })
    }
  })

  it('honours a narrowed allowedMethods list', async () => {
    const ctx = makeCtxWith('a=1', 'application/x-www-form-urlencoded', { method: 'DELETE' })
    await new BodyParserMiddleware({ allowedMethods: ['POST'] }).handle(ctx, noop)
    expect(ctx.request.body()).toEqual({})
  })

  it('skips a request whose content-length says there is no body', async () => {
    // Many clients send `content-length: 0` rather than omitting the header.
    const ctx = makeCtxWith('', 'application/x-www-form-urlencoded', {
      headers: { 'content-length': '0' },
    })
    let nextCalled = false
    await new BodyParserMiddleware().handle(ctx, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
  })

  it('parses a chunked body, which carries no content-length', async () => {
    const ctx = makeCtxWith('a=1', 'application/x-www-form-urlencoded', {
      headers: { 'content-length': '', 'transfer-encoding': 'chunked' },
    })
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ a: '1' })
  })
})

describe('BodyParserMiddleware — body size', () => {
  it('throws 413 rather than writing its own JSON envelope', async () => {
    const ctx = makeCtxWith('a=' + 'x'.repeat(2000), 'application/x-www-form-urlencoded', {})
    await expect(
      new BodyParserMiddleware({ form: { limit: '1kb' } }).handle(ctx, noop),
    ).rejects.toMatchObject({ status: 413, code: 'E_REQUEST_ENTITY_TOO_LARGE' })
  })
})

describe('BodyParserMiddleware — form-urlencoded', () => {
  it('decodes `+` as space (RFC 1866 / WHATWG URL form spec)', async () => {
    const ctx = makeCtx('name=Jean+Luc', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ name: 'Jean Luc' })
  })

  it('preserves a literal `+` encoded as `%2B`', async () => {
    const ctx = makeCtx('q=C%2B%2B', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ q: 'C++' })
  })

  it('decodes percent-escapes alongside `+` in the same value', async () => {
    const ctx = makeCtx('greeting=hello+world%21', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ greeting: 'hello world!' })
  })

  it('handles flag-style keys without value', async () => {
    const ctx = makeCtx('debug&trace=1', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware().handle(ctx, noop)
    // `null`, not `''`: AdonisJS ships `convertEmptyStringsToNull: true` for
    // form bodies, which is what a "nullable" validation rule expects to see.
    expect(ctx.request.body()).toEqual({ debug: null, trace: '1' })
  })

  it('keeps the empty string when the app turns the conversion off', async () => {
    const ctx = makeCtx('debug&trace=1', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware({
      form: { convertEmptyStringsToNull: false },
    }).handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ debug: '', trace: '1' })
  })

  it('nests bracket and dotted keys, and collects repeats', async () => {
    const ctx = makeCtx(
      'user[name]=ada&user.age=36&tags[]=x&tags[]=y',
      'application/x-www-form-urlencoded',
    )
    await new BodyParserMiddleware().handle(ctx, noop)
    // Flat parsing kept only the last `tags[]`, losing a checkbox group.
    expect(ctx.request.body()).toEqual({
      user: { name: 'ada', age: '36' },
      tags: ['x', 'y'],
    })
  })

  it('skips empty pairs from a leading `&`', async () => {
    const ctx = makeCtx('&a=1', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ a: '1' })
  })
})

describe('BodyParserMiddleware — raw text', () => {
  it('exposes the raw string under `_body`, since text/* is parsed by default', async () => {
    const ctx = makeCtx('hello world', 'text/plain')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ _body: 'hello world' })
  })

  it('leaves the body alone when raw is given no types', async () => {
    const ctx = makeCtx('hello world', 'text/plain')
    await new BodyParserMiddleware({ raw: { types: [] } }).handle(ctx, noop)
    // Nothing claims text/plain now, and Request.#ensureParsedBody falls back
    // to {} for a non-JSON body.
    expect(ctx.request.body()).toEqual({})
  })

  it('matches a wildcard type and ignores charset parameters', async () => {
    // AdonisJS defaults raw.types to `text/*`, so the matcher has to handle
    // both the wildcard and `; charset=utf-8`.
    const ctx = makeCtx('hi', 'text/csv; charset=utf-8')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ _body: 'hi' })
  })

  it('respects a custom raw.types list', async () => {
    const ctx = makeCtx('<doc/>', 'application/xml')
    await new BodyParserMiddleware({
      raw: { types: ['application/xml'] },
    }).handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ _body: '<doc/>' })
  })
})

describe('BodyParserMiddleware — multipart limits', () => {
  function makeMultipartCtx(
    fields: Array<{ name: string; value: string }>,
    files: Array<{ size: number }> = [],
  ): HttpContext {
    const raw: RawRequest = {
      method: 'POST',
      path: '/',
      query: '',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        // Non-zero: a multipart request always carries one, and the middleware
        // returns early without it.
        'content-length': '1',
      },
      body: '',
      multipart: {
        fields,
        files: files.map((f, i) => ({
          fieldName: `f${i}`,
          clientName: `f${i}.bin`,
          contentType: 'application/octet-stream',
          size: f.size,
          contentB64: '',
        })),
      },
    }
    return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
  }

  it('throws 413 E_REQUEST_ENTITY_TOO_LARGE when fields exceed maxFields', async () => {
    let nextCalled = false
    const ctx = makeMultipartCtx([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'c', value: '3' },
    ])
    // Thrown, not written: AdonisJS raises this exact code and status for an
    // exceeded `maxFields`, which lets the app's exception handler negotiate
    // the response instead of forcing a JSON envelope on an HTML app.
    await expect(
      new BodyParserMiddleware({ multipart: { maxFields: 2 } }).handle(ctx, async () => {
        nextCalled = true
      }),
    ).rejects.toMatchObject({ status: 413, code: 'E_REQUEST_ENTITY_TOO_LARGE' })
    expect(nextCalled).toBe(false)
  })

  it('allows the request when fields are within maxFields', async () => {
    let nextCalled = false
    const ctx = makeMultipartCtx([{ name: 'a', value: '1' }])
    await new BodyParserMiddleware({ multipart: { maxFields: 2 } }).handle(ctx, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
  })
})

describe('BodyParserMiddleware — disabling a parser', () => {
  it('a parser given no types does not claim the body', async () => {
    // How AdonisJS turns a parser off — there is no `enabled` flag upstream.
    const ctx = makeCtx('a=1', 'application/x-www-form-urlencoded')
    await new BodyParserMiddleware({ form: { types: [] } }).handle(ctx, noop)
    expect(ctx.request.body()).toEqual({})
  })

  it('json is parsed by default', async () => {
    const ctx = makeCtx('{"a":1}', 'application/json')
    await new BodyParserMiddleware().handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ a: 1 })
  })

  it('rejects `multipart.tmpDir`, which never wrote a file anywhere', async () => {
    // Accepting it silently let an app believe uploads landed on a volume.
    expect(() => new BodyParserMiddleware({ multipart: { tmpDir: '/mnt/up' } } as never)).toThrow(
      /E_BODYPARSER_CONFIG.*tmpDir/s,
    )
  })

  it('rejects the removed `enabled` flag instead of ignoring it', async () => {
    // Silently dropping it would re-enable a parser an app switched off.
    expect(() => new BodyParserMiddleware({ json: { enabled: false } } as never)).toThrow(
      /E_BODYPARSER_CONFIG/,
    )
  })
})

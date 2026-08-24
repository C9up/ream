import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function makeCtx(body: string, contentType: string): HttpContext {
  const raw: RawRequest = {
    method: 'POST',
    path: '/',
    query: '',
    headers: { 'content-type': contentType },
    body,
  }
  return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
}

const noop = async () => {}

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
  it('exposes the raw string under `_body` when raw.enabled is true', async () => {
    const ctx = makeCtx('hello world', 'text/plain')
    await new BodyParserMiddleware({ raw: { enabled: true } }).handle(ctx, noop)
    expect(ctx.request.body()).toEqual({ _body: 'hello world' })
  })

  it('is a no-op when raw.enabled is false (default)', async () => {
    const ctx = makeCtx('hello world', 'text/plain')
    await new BodyParserMiddleware().handle(ctx, noop)
    // text/plain is neither JSON nor form-encoded, and raw is disabled by
    // default — Request.#ensureParsedBody falls back to {} for non-JSON bodies.
    expect(ctx.request.body()).toEqual({})
  })

  it('respects a custom raw.types list', async () => {
    const ctx = makeCtx('<doc/>', 'application/xml')
    await new BodyParserMiddleware({
      raw: { enabled: true, types: ['application/xml'] },
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
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
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

  it('rejects with 400 E_TOO_MANY_FIELDS when fields exceed maxFields', async () => {
    let nextCalled = false
    const ctx = makeMultipartCtx([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'c', value: '3' },
    ])
    await new BodyParserMiddleware({ multipart: { maxFields: 2 } }).handle(ctx, async () => {
      nextCalled = true
    })
    expect(ctx.response.getStatus()).toBe(400)
    expect(ctx.response.getBody()).toContain('E_TOO_MANY_FIELDS')
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

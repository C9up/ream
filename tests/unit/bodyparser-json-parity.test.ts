/**
 * The JSON parser against `@adonisjs/bodyparser` 11.0.5 (define_config +
 * parsers/json.ts): a malformed body is a 400, not an empty input; `strict`
 * accepts only an object or an array (422 otherwise); every JSON media type
 * upstream claims is parsed; and string leaves go through
 * `trimWhitespaces` / `convertEmptyStringsToNull` — on JSON and multipart
 * alike, as they already did on url-encoded forms.
 */
import { describe, expect, it } from 'vitest'
import BodyParserMiddleware, {
  type BodyParserConfig,
} from '../../src/bodyparser/BodyParserMiddleware.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function post(body: string, contentType: string): HttpContext {
  const raw: RawRequest = {
    method: 'POST',
    path: '/',
    query: '',
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
    body,
  }
  return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
}

function multipart(fields: Array<{ name: string; value: string }>): HttpContext {
  const raw: RawRequest = {
    method: 'POST',
    path: '/',
    query: '',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1' },
    body: '',
    multipart: { fields, files: [] },
  }
  return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
}

async function parse(ctx: HttpContext, config?: BodyParserConfig): Promise<unknown> {
  let reached = false
  await new BodyParserMiddleware(config).handle(ctx, async () => {
    reached = true
  })
  expect(reached).toBe(true)
  return ctx.request.body()
}

describe('JSON body > malformed and non-container payloads', () => {
  it('rejects malformed JSON with a 400 instead of running the handler on {}', async () => {
    let reached = false
    const ctx = post('{"name": "x",}', 'application/json')

    await expect(
      new BodyParserMiddleware().handle(ctx, async () => {
        reached = true
      }),
    ).rejects.toMatchObject({ status: 400, code: 'E_BODYPARSER_INVALID_JSON' })
    expect(reached).toBe(false)
  })

  it('rejects a scalar under the default strict mode with a 422', async () => {
    for (const body of ['"x"', '42', 'true', 'null']) {
      await expect(
        new BodyParserMiddleware().handle(post(body, 'application/json'), async () => {}),
      ).rejects.toMatchObject({ status: 422, code: 'E_BODYPARSER_INVALID_JSON' })
    }
  })

  it('accepts a scalar once strict is turned off, under _body', async () => {
    expect(await parse(post('42', 'application/json'), { json: { strict: false } })).toEqual({
      _body: 42,
    })
  })

  it('accepts an array in strict mode, under _body', async () => {
    expect(await parse(post(' [1,2]', 'application/json'))).toEqual({ _body: [1, 2] })
  })
})

describe('JSON body > media types', () => {
  it('parses application/json-patch+json and application/csp-report by default', async () => {
    const patch = '[{"op":"replace","path":"/name","value":"y"}]'
    expect(await parse(post(patch, 'application/json-patch+json'))).toEqual({
      _body: [{ op: 'replace', path: '/name', value: 'y' }],
    })

    const report = '{"csp-report":{"document-uri":"https://app.test/"}}'
    expect(await parse(post(report, 'application/csp-report'))).toEqual({
      'csp-report': { 'document-uri': 'https://app.test/' },
    })
  })
})

describe('JSON body > normalisers', () => {
  it('trims string leaves and turns empty ones into null, keys untouched', async () => {
    const body = JSON.stringify({
      name: '   ',
      bio: '',
      title: '  hi  ',
      ' key ': ' v ',
      nested: { city: ' Geneva ', tags: [' a ', '', 3] },
      count: 0,
    })

    expect(await parse(post(body, 'application/json'))).toEqual({
      name: null,
      bio: null,
      title: 'hi',
      ' key ': 'v',
      nested: { city: 'Geneva', tags: ['a', null, 3] },
      count: 0,
    })
  })

  it('leaves strings alone when both normalisers are off', async () => {
    const body = '{"name":"  x  ","bio":""}'
    const config = { json: { trimWhitespaces: false, convertEmptyStringsToNull: false } }

    expect(await parse(post(body, 'application/json'), config)).toEqual({
      name: '  x  ',
      bio: '',
    })
  })
})

describe('multipart body > normalisers', () => {
  it('trims fields and turns empty ones into null by default', async () => {
    const ctx = multipart([
      { name: 'title', value: '' },
      { name: 'note', value: '  hi  ' },
    ])

    expect(await parse(ctx)).toEqual({ title: null, note: 'hi' })
  })

  it('honours the multipart switches', async () => {
    const ctx = multipart([
      { name: 'title', value: '' },
      { name: 'note', value: '  hi  ' },
    ])
    const config = { multipart: { trimWhitespaces: false, convertEmptyStringsToNull: false } }

    expect(await parse(ctx, config)).toEqual({ title: '', note: '  hi  ' })
  })
})

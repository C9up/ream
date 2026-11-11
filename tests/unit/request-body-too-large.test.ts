import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import { type RawRequest, Request } from '../../src/http/Request.js'

/**
 * A body over its native limit reaches JS empty, with `bodyTooLarge`. Nothing
 * may read that emptiness as the body the client sent.
 */
const overLimit: RawRequest = {
  method: 'POST',
  path: '/',
  query: 'page=2',
  headers: { 'content-type': 'application/json', 'content-length': '41943040' },
  body: '',
  bodyTooLarge: true,
}

const tooLarge = { status: 413, code: 'E_REQUEST_ENTITY_TOO_LARGE' }

function thrown(read: () => unknown): unknown {
  try {
    read()
  } catch (error) {
    return error
  }
  return undefined
}

describe('Request > over-limit body', () => {
  it('refuses every read of the body', () => {
    const request = new Request(overLimit)
    expect(thrown(() => request.raw())).toMatchObject(tooLarge)
    expect(thrown(() => request.rawBuffer())).toMatchObject(tooLarge)
    expect(thrown(() => request.body())).toMatchObject(tooLarge)
    expect(thrown(() => request.all())).toMatchObject(tooLarge)
    expect(thrown(() => request.input('name'))).toMatchObject(tooLarge)
  })

  it('still answers everything that is not the body', () => {
    const request = new Request(overLimit)
    expect(request.qs()).toEqual({ page: '2' })
    expect(request.hasBody()).toBe(true)
    expect(request.header('content-type')).toBe('application/json')
    expect(request.serialize()).toMatchObject({ body: undefined, method: 'POST' })
  })

  it('reads a body that middleware put in its place', () => {
    const request = new Request(overLimit)
    request.updateRawBody('replacement')
    expect(request.raw()).toBe('replacement')
  })

  it('is what the body parser raises, through the exception handler', async () => {
    const ctx = new HttpContext('id', overLimit, {}, { pattern: '/', middleware: [] })
    let reached = false
    const error = await new BodyParserMiddleware()
      .handle(ctx, async () => {
        reached = true
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject(tooLarge)
    expect(reached).toBe(false)
  })

  it('leaves a request without the marker alone', () => {
    const request = new Request({ ...overLimit, bodyTooLarge: undefined, body: '{"a":1}' })
    expect(request.raw()).toBe('{"a":1}')
    expect(request.body()).toEqual({})
  })
})

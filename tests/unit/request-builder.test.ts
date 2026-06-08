import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  type AuthStrategy,
  partialMatch,
  RequestBuilder,
} from '../../src/testing/RequestBuilder.js'
import type { TestResponse } from '../../src/testing/TestClient.js'

const makeResponse = (overrides: Partial<TestResponse> = {}): TestResponse => {
  const body = overrides.body ?? ''
  return {
    status: 200,
    headers: {},
    body,
    bodyBuffer: Buffer.from(body),
    json<T = unknown>(): T {
      return JSON.parse(body) as T
    },
    ...overrides,
  }
}

describe('helix > RequestBuilder', () => {
  it('headers()/header() merge into the outgoing request', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    await builder.headers({ 'X-A': '1', 'X-B': '2' }).header('X-C', '3').send()

    expect(sender).toHaveBeenCalledOnce()
    const init = sender.mock.calls[0][2]
    expect(init.headers['x-a']).toBe('1')
    expect(init.headers['x-b']).toBe('2')
    expect(init.headers['x-c']).toBe('3')
  })

  it('json() sets content-type and serialises body', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.json({ name: 'Ada' }).send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.body.toString('utf8')).toBe('{"name":"Ada"}')
  })

  it('form() emits application/x-www-form-urlencoded', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'POST', '/u')
    await builder.form({ a: '1', b: 'two words' }).send()

    const init = sender.mock.calls[0][2]
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.body.toString('utf8')).toBe('a=1&b=two%20words')
  })

  it('cookies() serialises to Cookie header', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    await builder.cookies({ s: 'abc', t: 'xyz' }).cookie('u', '1').send()

    const init = sender.mock.calls[0][2]
    expect(init.headers.cookie).toBe('s=abc; t=xyz; u=1')
  })

  it('withAuth() uses the injected AuthStrategy for headers and cookies', async () => {
    const sender = vi.fn(async () => makeResponse())
    const strategy: AuthStrategy = {
      headersFor: async (subject) => ({
        Authorization: `Bearer test-${subject.id}`,
      }),
      cookiesFor: async (subject) => ({ session: `sid-${subject.id}` }),
    }
    const builder = new RequestBuilder(sender, 'GET', '/me', strategy)
    await builder.withAuth({ id: 42 }).send()

    const init = sender.mock.calls[0][2]
    expect(init.headers.authorization).toBe('Bearer test-42')
    expect(init.headers.cookie).toBe('session=sid-42')
  })

  it('asUser() is a shortcut for withAuth({id})', async () => {
    const sender = vi.fn(async () => makeResponse())
    const strategy: AuthStrategy = {
      headersFor: async (s) => ({ 'X-User': String(s.id) }),
    }
    const builder = new RequestBuilder(sender, 'GET', '/me', strategy)
    await builder.asUser('u-99').send()

    expect(sender.mock.calls[0][2].headers['x-user']).toBe('u-99')
  })

  it('withAuth() without an AuthStrategy throws a helpful error', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/x')
    await expect(builder.withAuth({ id: 1 }).send()).rejects.toThrow(/no AuthStrategy was provided/)
  })

  it('send() is memoised — multiple `await`s produce a single call', async () => {
    const sender = vi.fn(async () => makeResponse())
    const builder = new RequestBuilder(sender, 'GET', '/p')
    const a = builder.send()
    const b = builder.send()
    await Promise.all([a, b])
    expect(sender).toHaveBeenCalledOnce()
  })

  it('send() returns the response directly (explicit await)', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 201, body: '{"ok":true}' }))
    const builder = new RequestBuilder(sender, 'GET', '/p')
    const res = await builder.send()
    expect(res.status).toBe(201)
  })

  it('expectStatus() passes when codes match, fails otherwise', async () => {
    const sender = vi.fn(async () => makeResponse({ status: 200 }))
    await expect(new RequestBuilder(sender, 'GET', '/p').expectStatus(200)).resolves.toBeDefined()

    const sender2 = vi.fn(async () => makeResponse({ status: 500, body: 'kaboom' }))
    await expect(new RequestBuilder(sender2, 'GET', '/p').expectStatus(200)).rejects.toThrow(
      /Expected status 200, got 500/,
    )
  })

  it('expectHeader() matches exact strings and RegExp', async () => {
    const sender = vi.fn(async () => makeResponse({ headers: { 'x-trace': 'req-123' } }))
    await new RequestBuilder(sender, 'GET', '/p')
      .expectHeader('x-trace', 'req-123')
      .then((b) => b.expectHeader('X-Trace', /^req-/))
  })

  it('expectHeader() throws when header missing or mismatched', async () => {
    const sender = vi.fn(async () => makeResponse({ headers: { 'x-trace': 'abc' } }))
    await expect(
      new RequestBuilder(sender, 'GET', '/p').expectHeader('x-missing', 'x'),
    ).rejects.toThrow(/Expected header x-missing/)
    await expect(
      new RequestBuilder(sender, 'GET', '/p').expectHeader('x-trace', 'xyz'),
    ).rejects.toThrow(/Expected header x-trace = "xyz"/)
  })

  it('expectCookie() parses Set-Cookie and matches', async () => {
    const sender = vi.fn(async () =>
      makeResponse({
        headers: { 'set-cookie': 'session=abc; HttpOnly, theme=dark' },
      }),
    )
    await new RequestBuilder(sender, 'GET', '/p')
      .expectCookie('session', 'abc')
      .then((b) => b.expectCookie('theme', /^(dark|light)$/))
      .then((b) => b.expectCookie('session'))
  })

  it('expectJson() performs partial match', async () => {
    const sender = vi.fn(async () => makeResponse({ body: '{"id":1,"name":"Ada","extra":true}' }))
    await new RequestBuilder(sender, 'GET', '/me').expectJson({
      id: 1,
      name: 'Ada',
    })

    const sender2 = vi.fn(async () => makeResponse({ body: '{"id":1}' }))
    await expect(new RequestBuilder(sender2, 'GET', '/me').expectJson({ id: 2 })).rejects.toThrow(
      /JSON partial match failed/,
    )
  })

  it('assertion chain survives across awaits', async () => {
    const sender = vi.fn(async () =>
      makeResponse({
        status: 201,
        headers: { 'x-trace': 'xyz' },
        body: '{"id":7}',
      }),
    )
    await new RequestBuilder(sender, 'POST', '/u')
      .json({ name: 'Lin' })
      .expectStatus(201)
      .then((b) => b.expectHeader('x-trace', 'xyz'))
      .then((b) => b.expectJson({ id: 7 }))
  })
})

describe('helix > partialMatch', () => {
  it('matches primitives by strict equality', () => {
    expect(partialMatch(1, 1)).toBe(true)
    expect(partialMatch(1, 2)).toBe(false)
    expect(partialMatch('a', 'a')).toBe(true)
    expect(partialMatch(null, null)).toBe(true)
    expect(partialMatch(undefined, undefined)).toBe(true)
  })

  it('matches objects by partial keys', () => {
    expect(partialMatch({ a: 1, b: 2 }, { a: 1 })).toBe(true)
    expect(partialMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(partialMatch({ nested: { x: 1, y: 2 } }, { nested: { x: 1 } })).toBe(true)
  })

  it('matches arrays order-independently (every expected has a match)', () => {
    expect(partialMatch([1, 2, 3], [3, 1])).toBe(true)
    expect(partialMatch([{ id: 1 }, { id: 2 }], [{ id: 2 }])).toBe(true)
    expect(partialMatch([{ id: 1 }], [{ id: 2 }])).toBe(false)
  })
})

/**
 * `JSON.parse` turns a `"__proto__"` key into an OWN property, and the body
 * parser handed it on to `request.body()`. Copying that body with
 * `Object.assign` (or a deep merge) then ran the `__proto__` setter and
 * swapped the target's prototype. AdonisJS parses with `safeParse` from
 * `@poppinss/utils/json`, which removes `__proto__` and a `constructor`
 * carrying `prototype`.
 */
import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import { safeJsonParse } from '../../src/utils/safeJsonParse.js'

function postJson(body: string): HttpContext {
  return new HttpContext(
    'test',
    {
      method: 'POST',
      path: '/',
      query: '',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body, 'utf8')),
      },
      body,
    },
    {},
    { pattern: '/', middleware: [] },
  )
}

describe('JSON body > prototype-poisoning keys', () => {
  it('drops a __proto__ key, so Object.assign cannot swap a prototype', async () => {
    const ctx = postJson('{"name":"x","__proto__":{"isAdmin":true}}')
    await new BodyParserMiddleware().handle(ctx, async () => {})

    const body = ctx.request.body()
    expect(body).toEqual({ name: 'x' })
    expect(Object.keys(Object(body))).toEqual(['name'])

    const user = { name: 'old' }
    Object.assign(user, body)
    expect(Object.getPrototypeOf(user)).toBe(Object.prototype)
    expect(Reflect.get(user, 'isAdmin')).toBeUndefined()
  })

  it('drops nested __proto__ keys and a constructor carrying prototype', async () => {
    const ctx = postJson(
      '{"profile":{"__proto__":{"role":"admin"},"bio":"hi"},"constructor":{"prototype":{"x":1}},"list":[{"__proto__":{"a":1}}]}',
    )
    await new BodyParserMiddleware().handle(ctx, async () => {})

    expect(ctx.request.body()).toEqual({ profile: { bio: 'hi' }, list: [{}] })
    expect(Object.hasOwn(ctx.request.all(), 'constructor')).toBe(false)
  })

  it('keeps a constructor key that is just a value', () => {
    expect(safeJsonParse('{"constructor":"Ford"}')).toEqual({ constructor: 'Ford' })
  })
})

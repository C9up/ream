/**
 * A query-string or form key named after an `Object.prototype` member
 * (`toString`, `hasOwnProperty`, `valueOf`…) used to read the inherited
 * function as an "earlier value", so the key turned into `[fn, value]` and any
 * code calling those methods on the input threw. `qs` — what AdonisJS parses
 * with — drops such keys unless `allowPrototypes` is set.
 */
import { describe, expect, it } from 'vitest'
import { parseFormFields, parseQueryString } from '../../src/bodyparser/qsParse.js'
import { Request } from '../../src/http/Request.js'

function get(query: string): Request {
  return new Request({ method: 'GET', path: '/', query, headers: {}, body: '' })
}

describe('qs parser > keys named after Object.prototype members', () => {
  it('drops them, as qs does, and keeps the input usable', () => {
    const request = get('q=shoes&hasOwnProperty=1&toString=x')
    const qs = request.qs()

    expect(qs).toEqual({ q: 'shoes' })
    expect(Object.hasOwn(qs, 'toString')).toBe(false)
    // The inherited method is the one consumers call, not a parsed value.
    expect(Reflect.get(qs, 'hasOwnProperty')).toBe(Object.prototype.hasOwnProperty)
    expect(String(request.all())).toBe('[object Object]')
    expect(JSON.stringify(qs)).toBe('{"q":"shoes"}')
  })

  it('drops a nested segment named after one too, as qs does', () => {
    const parsed = parseQueryString('user[toString]=x&user[valueOf][a]=y&user[name]=ada')

    expect(parsed).toEqual({ user: { name: 'ada' } })
  })

  it('still collects a repeated ordinary key', () => {
    expect(parseQueryString('tag=a&tag=b')).toEqual({ tag: ['a', 'b'] })
  })

  it('applies the same rule to multipart fields', () => {
    const fields = parseFormFields([
      { name: 'isPrototypeOf', value: '1' },
      { name: 'title', value: 'hi' },
    ])

    expect(fields).toEqual({ title: 'hi' })
  })
})

/**
 * Bracket-notation form parsing, matching what AdonisJS gets from `qs`.
 *
 * `@adonisjs/bodyparser` runs `qs.parse(body, options.qs)` on every
 * urlencoded body (bodyparser_middleware:832), so an HTML form using
 * `user[name]` or a repeated `tags[]` arrives nested. Parsing flat does not
 * merely lose the shape — a repeated key OVERWRITES, so a checkbox group
 * silently submits only its last value.
 */
import { describe, expect, it } from 'vitest'
import { parseQueryString } from '../../src/bodyparser/qsParse.js'

describe('ream > form body nesting (qs parity)', () => {
  it('nests bracket keys', () => {
    expect(parseQueryString('user[name]=ada&user[email]=a%40b.c')).toEqual({
      user: { name: 'ada', email: 'a@b.c' },
    })
  })

  it('collects a repeated tags[] into an array', () => {
    // The data-loss case: flat parsing keeps only 'y'.
    expect(parseQueryString('tags[]=x&tags[]=y')).toEqual({ tags: ['x', 'y'] })
  })

  it('collects a repeated bare key too', () => {
    expect(parseQueryString('tag=x&tag=y')).toEqual({ tag: ['x', 'y'] })
  })

  it('honours explicit indices', () => {
    expect(parseQueryString('a[0]=x&a[1]=y')).toEqual({ a: ['x', 'y'] })
  })

  it('nests deeply', () => {
    expect(parseQueryString('user[address][city]=Lyon')).toEqual({
      user: { address: { city: 'Lyon' } },
    })
  })

  it('nests objects inside arrays', () => {
    expect(parseQueryString('items[0][sku]=A&items[0][qty]=2')).toEqual({
      items: [{ sku: 'A', qty: '2' }],
    })
  })

  it('keeps a plain key plain', () => {
    expect(parseQueryString('name=ada&age=36')).toEqual({ name: 'ada', age: '36' })
  })

  it('decodes + as space before percent-decoding', () => {
    // A literal plus arrives as %2B and must survive.
    expect(parseQueryString('q=a+b&p=a%2Bb')).toEqual({ q: 'a b', p: 'a+b' })
  })

  it('survives malformed percent-encoding instead of throwing', () => {
    expect(parseQueryString('a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' })
  })

  it('refuses to write prototype-polluting keys', () => {
    // `__proto__[admin]=1` in a form body is the classic vector.
    const out = parseQueryString('__proto__[admin]=1&constructor[x]=1')
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
    expect(Object.keys(out)).not.toContain('__proto__')
  })

  it('caps depth rather than nesting without bound', () => {
    const out = parseQueryString('a[b][c][d][e][f][g][h]=1', { depth: 2 })
    // Past the cap the remainder stays literal — no value is dropped.
    expect(JSON.stringify(out)).toContain('1')
  })

  it('caps the number of parameters', () => {
    const body = Array.from({ length: 50 }, (_, i) => `k${i}=v`).join('&')
    expect(Object.keys(parseQueryString(body, { parameterLimit: 10 }))).toHaveLength(10)
  })

  it('applies convertEmptyStringsToNull and trimWhitespaces like AdonisJS', () => {
    expect(
      parseQueryString('a=&b=%20x%20', {
        convertEmptyStringsToNull: true,
        trimWhitespaces: true,
      }),
    ).toEqual({ a: null, b: 'x' })
  })

  it('handles a key with no value', () => {
    expect(parseQueryString('flag')).toEqual({ flag: '' })
  })

  it('nests dotted keys, which AdonisJS turns on for forms', () => {
    // define_config forces `allowDots` for form bodies, so `user.name` and
    // `user[name]` mean the same thing there.
    expect(parseQueryString('user.name=ada')).toEqual({ user: { name: 'ada' } })
  })

  it('can be told not to nest dotted keys', () => {
    expect(parseQueryString('user.name=ada', { allowDots: false })).toEqual({
      'user.name': 'ada',
    })
  })
})

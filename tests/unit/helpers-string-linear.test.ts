/**
 * The string helpers run in time linear in their input.
 *
 * `([A-Z]+)([A-Z][a-z])` (the case helpers), `<[^>]*>` (`excerpt`) and the
 * lazy `\\{{…}}` of `interpolate` each re-scanned the rest of the input from
 * every start position of a run they could not finish: 20 000 capitals cost a
 * third of a second, a 1 MB body minutes. Each was replaced by a single pass
 * that answers what the expression answered; the fuzz below checks that
 * against the original expressions.
 */
import { describe, expect, it } from 'vitest'
import {
  camelCase,
  excerpt,
  interpolate,
  noCase,
  pascalCase,
  snakeCase,
} from '../../src/helpers/string.js'

/** The expressions the helpers used, kept here as the reference. */
const reference = {
  splitWords(s: string): string[] {
    return s
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[\s\-_]+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ')
      .filter((w) => w.length > 0)
  },
  stripTags(s: string): string {
    return s.replace(/<[^>]*>/g, '')
  },
  interpolate(template: string, data: Record<string, unknown>): string {
    return template.replace(
      /\\(\{\{[\s\S]*?\}\})|(\{\{\s*([\w.]+)\s*\}\})/g,
      (_match, escaped: string | undefined, _full: string | undefined, path: string) => {
        if (escaped !== undefined) return escaped
        let current: unknown = data
        for (const key of path.split('.')) {
          if (current === null || current === undefined || typeof current !== 'object') return ''
          current = Reflect.get(current, key)
        }
        return current !== null && current !== undefined ? String(current) : ''
      },
    )
  },
}

/** A small deterministic generator, so a failure reproduces. */
function* strings(alphabet: string, count: number, maxLength: number): Generator<string> {
  let seed = 0x2545f491
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x1_0000_0000
  }
  for (let n = 0; n < count; n += 1) {
    const length = Math.floor(next() * maxLength)
    let s = ''
    for (let i = 0; i < length; i += 1) s += alphabet.charAt(Math.floor(next() * alphabet.length))
    yield s
  }
}

function timed(fn: () => unknown): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('helpers > string > same answers as before', () => {
  it('splits words as the two expressions did', () => {
    for (const s of strings('ABCabc1 -_', 3000, 24)) {
      expect(noCase(s)).toBe(reference.splitWords(s).join(' '))
    }
    expect(snakeCase('XMLParser')).toBe('xml_parser')
    expect(camelCase('parseHTTPResponseCode')).toBe('parseHttpResponseCode')
    expect(pascalCase('ABCDef')).toBe('AbcDef')
  })

  it('strips tags as /<[^>]*>/g did', () => {
    for (const s of strings('<>ab /', 3000, 24)) {
      expect(excerpt(s, 1000, { suffix: '' })).toBe(reference.stripTags(s))
    }
  })

  it('interpolates as the expression did', () => {
    const data = { a: { b: 'B' }, x: 'X', n: 0 }
    for (const s of strings('{}\\ a.bxn', 5000, 24)) {
      expect(interpolate(s, data)).toBe(reference.interpolate(s, data))
    }
    expect(interpolate('Hello {{ a.b }}! \\{{ x }} {{x}}', data)).toBe('Hello B! {{ x }} X')
  })
})

describe('helpers > string > linear time', () => {
  // Small inputs, generous bound: the quadratic versions took about 350 ms
  // on 20 000 characters; one pass takes a few.
  const n = 20_000

  it('converts a long run of capitals', () => {
    for (const fn of [snakeCase, camelCase, pascalCase, noCase]) {
      expect(timed(() => fn('A'.repeat(n)))).toBeLessThan(100)
    }
  })

  it('strips a long run of unclosed tags', () => {
    expect(timed(() => excerpt('<'.repeat(n), 10))).toBeLessThan(100)
  })

  it('interpolates a long run of unclosed escapes', () => {
    expect(timed(() => interpolate('\\{{'.repeat(n / 3), {}))).toBeLessThan(100)
  })
})

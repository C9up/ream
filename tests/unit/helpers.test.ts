import { describe, expect, it } from 'vitest'
import { base64 } from '../../src/helpers/base64.js'
import is, {
  isArray,
  isBoolean,
  isBuffer,
  isDate,
  isEmpty as isEmptyIs,
  isError,
  isFunction,
  isNull,
  isNullOrUndefined,
  isNumber,
  isObject,
  isPlainObject,
  isPromise,
  isRegExp,
  isString,
  isUndefined,
} from '../../src/helpers/is.js'
import { safeEqual } from '../../src/helpers/safeEqual.js'
import string, {
  camelCase,
  condenseWhitespace,
  dashCase,
  encodeSymbols,
  escapeHTML,
  excerpt,
  generateRandom,
  humanize,
  interpolate,
  isEmpty as isEmptyStr,
  isPlural,
  isSingular,
  ordinal,
  pascalCase,
  plural,
  prettyHrTime,
  random,
  singular,
  slug,
  snakeCase,
  titleCase,
  toUnixSlash,
  truncate,
} from '../../src/helpers/string.js'

// ---------------------------------------------------------------------------
// safeEqual
// ---------------------------------------------------------------------------

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('secret', 'secret')).toBe(true)
  })

  it('returns false for different strings', () => {
    expect(safeEqual('secret', 'wrong')).toBe(false)
  })

  it('returns false when lengths differ', () => {
    expect(safeEqual('abc', 'ab')).toBe(false)
  })

  it('works with Buffer inputs', () => {
    const a = Buffer.from('hello')
    const b = Buffer.from('hello')
    expect(safeEqual(a, b)).toBe(true)
  })

  it('works with mixed string and Buffer', () => {
    expect(safeEqual('hello', Buffer.from('hello'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

describe('base64 > encode', () => {
  it('encodes a string to standard base64', () => {
    expect(base64.encode('hello')).toBe('aGVsbG8=')
  })

  it('encodes a Buffer', () => {
    expect(base64.encode(Buffer.from('hello'))).toBe('aGVsbG8=')
  })
})

describe('base64 > decode', () => {
  it('decodes a valid base64 string', () => {
    expect(base64.decode('aGVsbG8=')).toBe('hello')
  })

  it('returns null for invalid base64', () => {
    expect(base64.decode('!!!')).toBeNull()
  })

  it('throws in strict mode for invalid input', () => {
    expect(() => base64.decode('!!!', 'utf-8', true)).toThrow(/Invalid base64/)
  })
})

describe('base64 > urlEncode', () => {
  it('encodes to base64url without padding', () => {
    const encoded = base64.urlEncode('hello')
    expect(encoded).toBe('aGVsbG8')
    expect(encoded).not.toContain('=')
  })
})

describe('base64 > urlDecode', () => {
  it('decodes a valid base64url string', () => {
    expect(base64.urlDecode('aGVsbG8')).toBe('hello')
  })

  it('returns null for invalid base64url', () => {
    expect(base64.urlDecode('===')).toBeNull()
  })

  it('throws in strict mode for invalid input', () => {
    expect(() => base64.urlDecode('===', 'utf-8', true)).toThrow(/Invalid base64url/)
  })
})

// ---------------------------------------------------------------------------
// is
// ---------------------------------------------------------------------------

describe('is > isString', () => {
  it('returns true for strings', () => expect(isString('hi')).toBe(true))
  it('returns false for non-strings', () => expect(isString(42)).toBe(false))
  it('is accessible on default export', () => expect(is.string('x')).toBe(true))
})

/**
 * The namespace is keyed the way AdonisJS keys it — it re-exports
 * `@sindresorhus/is`, where the members read `is.string(v)`. This object used
 * to mirror the function names, so `is.string(value)` ported from an Adonis
 * app was `undefined` and threw "is not a function" at runtime.
 */
describe('is > namespace shape', () => {
  it('exposes the AdonisJS member names, not the stuttering ones', () => {
    expect(typeof is.string).toBe('function')
    expect(typeof is.plainObject).toBe('function')
    expect(typeof is.nonEmptyArray).toBe('function')
    // The stutter is gone, not aliased — keeping both would keep it alive.
    expect('isString' in is).toBe(false)
  })

  it('covers the members the AdonisJS docs use in their own examples', () => {
    expect(is.array([1]) && is.nonEmptyArray([1])).toBe(true)
    expect(is.nonEmptyArray([])).toBe(false)
    expect(is.plainObject({ name: 'a' }) && is.hasProperty({ name: 'a' }, 'name')).toBe(true)
    expect(is.number(3) && is.integer(3) && is.positive(3)).toBe(true)
    expect(is.integer(3.5)).toBe(false)
    // Zero is not positive, matching @sindresorhus/is.
    expect(is.positive(0)).toBe(false)
    expect(is.nonEmptyString('hi')).toBe(true)
    expect(is.nonEmptyString('')).toBe(false)
  })

  it('reports only OWN properties, so an inherited member is not data', () => {
    expect(is.hasProperty({}, 'toString')).toBe(false)
    expect(is.hasProperty(Object.create({ inherited: 1 }), 'inherited')).toBe(false)
    expect(is.hasProperty(null, 'anything')).toBe(false)
  })
})

describe('is > isNumber', () => {
  it('returns true for numbers', () => expect(isNumber(42)).toBe(true))
  it('returns false for NaN', () => expect(isNumber(NaN)).toBe(false))
  it('returns false for strings', () => expect(isNumber('42')).toBe(false))
})

describe('is > isBoolean', () => {
  it('returns true for booleans', () => expect(isBoolean(false)).toBe(true))
  it('returns false for 0', () => expect(isBoolean(0)).toBe(false))
})

describe('is > isFunction', () => {
  it('returns true for arrow functions', () => expect(isFunction(() => {})).toBe(true))
  it('returns true for named functions', () => expect(isFunction(function foo() {})).toBe(true))
  it('returns false for objects', () => expect(isFunction({})).toBe(false))
})

describe('is > isObject', () => {
  it('returns true for objects', () => expect(isObject({})).toBe(true))
  it('returns true for arrays', () => expect(isObject([])).toBe(true))
  it('returns false for null', () => expect(isObject(null)).toBe(false))
})

describe('is > isPlainObject', () => {
  it('returns true for plain objects', () => expect(isPlainObject({ a: 1 })).toBe(true))
  it('returns false for arrays', () => expect(isPlainObject([])).toBe(false))
  it('returns false for class instances', () => expect(isPlainObject(new Date())).toBe(false))
  it('returns true for Object.create(null)', () =>
    expect(isPlainObject(Object.create(null))).toBe(true))
})

describe('is > isArray', () => {
  it('returns true for arrays', () => expect(isArray([1, 2])).toBe(true))
  it('returns false for objects', () => expect(isArray({})).toBe(false))
})

describe('is > isPromise', () => {
  it('returns true for resolved promises', () => expect(isPromise(Promise.resolve())).toBe(true))
  // biome-ignore lint/suspicious/noThenProperty: the `then` property IS the test — isPromise must detect a thenable
  it('returns true for thenable objects', () => expect(isPromise({ then: () => {} })).toBe(true))
  it('returns false for plain objects', () => expect(isPromise({})).toBe(false))
})

describe('is > isNull', () => {
  it('returns true for null', () => expect(isNull(null)).toBe(true))
  it('returns false for undefined', () => expect(isNull(undefined)).toBe(false))
})

describe('is > isUndefined', () => {
  it('returns true for undefined', () => expect(isUndefined(undefined)).toBe(true))
  it('returns false for null', () => expect(isUndefined(null)).toBe(false))
})

describe('is > isNullOrUndefined', () => {
  it('returns true for null', () => expect(isNullOrUndefined(null)).toBe(true))
  it('returns true for undefined', () => expect(isNullOrUndefined(undefined)).toBe(true))
  it('returns false for 0', () => expect(isNullOrUndefined(0)).toBe(false))
})

describe('is > isBuffer', () => {
  it('returns true for Buffer', () => expect(isBuffer(Buffer.from('hi'))).toBe(true))
  it('returns false for Uint8Array', () => expect(isBuffer(new Uint8Array())).toBe(false))
})

describe('is > isDate', () => {
  it('returns true for Date', () => expect(isDate(new Date())).toBe(true))
  it('returns false for date strings', () => expect(isDate('2020-01-01')).toBe(false))
})

describe('is > isRegExp', () => {
  it('returns true for RegExp', () => expect(isRegExp(/foo/)).toBe(true))
  it('returns false for strings', () => expect(isRegExp('foo')).toBe(false))
})

describe('is > isError', () => {
  it('returns true for Error', () => expect(isError(new Error())).toBe(true))
  it('returns false for plain objects', () => expect(isError({ message: 'x' })).toBe(false))
})

describe('is > isEmpty', () => {
  it('returns true for null', () => expect(isEmptyIs(null)).toBe(true))
  it('returns true for undefined', () => expect(isEmptyIs(undefined)).toBe(true))
  it('returns true for empty string', () => expect(isEmptyIs('')).toBe(true))
  it('returns true for empty array', () => expect(isEmptyIs([])).toBe(true))
  it('returns true for empty object', () => expect(isEmptyIs({})).toBe(true))
  it('returns true for empty Map', () => expect(isEmptyIs(new Map())).toBe(true))
  it('returns true for empty Set', () => expect(isEmptyIs(new Set())).toBe(true))
  it('returns false for non-empty string', () => expect(isEmptyIs('x')).toBe(false))
  it('returns false for non-empty array', () => expect(isEmptyIs([1])).toBe(false))
})

// ---------------------------------------------------------------------------
// string
// ---------------------------------------------------------------------------

describe('string > camelCase', () => {
  it('converts snake_case', () => expect(camelCase('user_name')).toBe('userName'))
  it('converts kebab-case', () => expect(camelCase('hello-world')).toBe('helloWorld'))
  it('converts PascalCase', () => expect(camelCase('UserName')).toBe('userName'))
  it('converts space separated', () => expect(camelCase('user name')).toBe('userName'))
  it('is accessible on default export', () => expect(string.camelCase('foo_bar')).toBe('fooBar'))
})

describe('string > snakeCase', () => {
  it('converts camelCase', () => expect(snakeCase('userName')).toBe('user_name'))
  it('converts PascalCase', () => expect(snakeCase('UserName')).toBe('user_name'))
  it('converts space separated', () => expect(snakeCase('user name')).toBe('user_name'))
})

describe('string > pascalCase', () => {
  it('converts space separated', () => expect(pascalCase('user team')).toBe('UserTeam'))
  it('converts snake_case', () => expect(pascalCase('user_name')).toBe('UserName'))
})

describe('string > dashCase', () => {
  it('converts camelCase to kebab', () => expect(dashCase('helloWorld')).toBe('hello-world'))
  it('capitalizes segments when option set', () =>
    expect(dashCase('helloWorld', { capitalize: true })).toBe('Hello-World'))
})

describe('string > titleCase', () => {
  it('capitalizes each word', () => expect(titleCase('hello world')).toBe('Hello World'))
  it('handles snake_case input', () => expect(titleCase('hello_world')).toBe('Hello World'))
})

describe('string > humanize', () => {
  it('converts snake_case to human form', () => expect(humanize('user_name')).toBe('User name'))
  it('converts camelCase to human form', () => expect(humanize('userName')).toBe('User name'))
})

describe('string > truncate', () => {
  it('truncates with default suffix', () => expect(truncate('Hello world', 8)).toBe('Hello...'))
  it('preserves string shorter than maxLength', () => expect(truncate('Hi', 10)).toBe('Hi'))
  it('uses custom suffix', () =>
    expect(truncate('Hello world', 9, { suffix: '…' })).toBe('Hello wo…'))
  it('completes words when option set', () =>
    expect(truncate('Hello world foo', 12, { completeWords: true })).toBe('Hello...'))
})

describe('string > excerpt', () => {
  it('strips HTML tags before truncating', () =>
    expect(excerpt('<p>Hello world</p>', 8)).toBe('Hello...'))
})

describe('string > escapeHTML', () => {
  it('escapes HTML characters', () => expect(escapeHTML('<b>hi</b>')).toBe('&lt;b&gt;hi&lt;/b&gt;'))
  it('escapes ampersands', () => expect(escapeHTML('a & b')).toBe('a &amp; b'))
  it('escapes quotes', () => expect(escapeHTML('"test"')).toBe('&quot;test&quot;'))
  it('encodes non-ASCII when option set', () => {
    const result = escapeHTML('héllo', { encodeSymbols: true })
    expect(result).toContain('&#x')
  })
})

describe('string > encodeSymbols', () => {
  it('encodes non-ASCII characters', () => expect(encodeSymbols('héllo')).toContain('&#x'))
  it('leaves ASCII untouched', () => expect(encodeSymbols('hello')).toBe('hello'))
})

describe('string > isEmpty', () => {
  it('returns true for empty string', () => expect(isEmptyStr('')).toBe(true))
  it('returns true for whitespace-only string', () => expect(isEmptyStr('   ')).toBe(true))
  it('returns false for non-empty string', () => expect(isEmptyStr('hi')).toBe(false))
})

describe('string > condenseWhitespace', () => {
  it('collapses internal whitespace', () =>
    expect(condenseWhitespace('  hello   world  ')).toBe('hello world'))
})

describe('string > slug', () => {
  it('creates a lowercase slug', () => expect(slug('Hello World!')).toBe('hello-world'))
  it('collapses repeated separators', () => expect(slug('hello  world')).toBe('hello-world'))
  it('uses custom replacement', () =>
    expect(slug('hello world', { replacement: '_' })).toBe('hello_world'))
})

describe('string > plural', () => {
  it('pluralizes regular words', () => expect(plural('dog')).toBe('dogs'))
  it('pluralizes -s ending words', () => expect(plural('bus')).toBe('buses'))
  it('pluralizes -y ending words', () => expect(plural('city')).toBe('cities'))
  it('handles irregulars', () => expect(plural('person')).toBe('people'))
  it('handles uncountable words', () => expect(plural('sheep')).toBe('sheep'))
  it('pluralizes child', () => expect(plural('child')).toBe('children'))
})

describe('string > singular', () => {
  it('singularizes regular words', () => expect(singular('dogs')).toBe('dog'))
  it('singularizes -es ending words', () => expect(singular('buses')).toBe('bus'))
  it('singularizes -ies ending words', () => expect(singular('cities')).toBe('city'))
  it('handles irregulars', () => expect(singular('people')).toBe('person'))
  it('handles uncountable words', () => expect(singular('sheep')).toBe('sheep'))
})

describe('string > isPlural', () => {
  it('returns true for plural words', () => expect(isPlural('dogs')).toBe(true))
  it('returns false for singular words', () => expect(isPlural('dog')).toBe(false))
})

describe('string > isSingular', () => {
  it('returns true for singular words', () => expect(isSingular('dog')).toBe(true))
  it('returns false for plural words', () => expect(isSingular('dogs')).toBe(false))
})

describe('string > random', () => {
  it('returns a string of the requested length', () => expect(random(16)).toHaveLength(16))
  it('returns different values on each call', () => expect(random(16)).not.toBe(random(16)))
  it('only contains base64url characters', () => expect(random(32)).toMatch(/^[A-Za-z0-9_-]+$/))
})

describe('string > generateRandom', () => {
  it('is an alias for random with the same length contract', () => {
    expect(generateRandom(20)).toHaveLength(20)
  })
})

describe('string > ordinal', () => {
  it('1 → 1st', () => expect(ordinal(1)).toBe('1st'))
  it('2 → 2nd', () => expect(ordinal(2)).toBe('2nd'))
  it('3 → 3rd', () => expect(ordinal(3)).toBe('3rd'))
  it('4 → 4th', () => expect(ordinal(4)).toBe('4th'))
  it('11 → 11th', () => expect(ordinal(11)).toBe('11th'))
  it('12 → 12th', () => expect(ordinal(12)).toBe('12th'))
  it('13 → 13th', () => expect(ordinal(13)).toBe('13th'))
  it('21 → 21st', () => expect(ordinal(21)).toBe('21st'))
  it('22 → 22nd', () => expect(ordinal(22)).toBe('22nd'))
})

describe('string > prettyHrTime', () => {
  it('formats nanoseconds as ms', () => expect(prettyHrTime([0, 1234567])).toBe('1.235 ms'))
  it('formats seconds', () => expect(prettyHrTime([2, 0])).toBe('2.000 s'))
  it('formats minutes', () => expect(prettyHrTime([65, 0])).toBe('1m 5s'))
})

describe('string > toUnixSlash', () => {
  it('replaces backslashes with forward slashes', () => {
    expect(toUnixSlash('C:\\foo\\bar')).toBe('C:/foo/bar')
  })
  it('leaves forward slashes unchanged', () => {
    expect(toUnixSlash('/usr/local/bin')).toBe('/usr/local/bin')
  })
})

describe('string > interpolate', () => {
  it('replaces simple placeholders', () => {
    expect(interpolate('Hello {{ name }}!', { name: 'Alice' })).toBe('Hello Alice!')
  })

  it('resolves nested key paths', () => {
    expect(interpolate('{{ user.name }}', { user: { name: 'Bob' } })).toBe('Bob')
  })

  it('returns empty string for missing keys', () => {
    expect(interpolate('{{ missing }}', {})).toBe('')
  })

  it('outputs literal {{ when escaped with backslash', () => {
    expect(interpolate('\\{{ not replaced }}', {})).toBe('{{ not replaced }}')
  })
})

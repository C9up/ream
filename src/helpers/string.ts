import { randomBytes } from 'node:crypto'
import bytes from './bytes.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split an arbitrary-cased string into lowercase words.
 * Handles camelCase, PascalCase, snake_case, kebab-case, and space-separated.
 */
function splitWords(s: string): string[] {
  return (
    s
      // Insert space before uppercase letters that follow lowercase letters or digits
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      // Insert space before uppercase letters followed by lowercase (handles "XMLParser" -> "XML Parser")
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      // Replace non-alphanumeric separators with space
      .replace(/[\s\-_]+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ')
      .filter((w) => w.length > 0)
  )
}

// ---------------------------------------------------------------------------
// Case conversion
// ---------------------------------------------------------------------------

/**
 * Converts a string to camelCase.
 * @example camelCase('user_name') // 'userName'
 */
export function camelCase(s: string): string {
  const words = splitWords(s)
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('')
}

/**
 * Converts a string to snake_case.
 * @example snakeCase('userName') // 'user_name'
 */
export function snakeCase(s: string): string {
  return splitWords(s).join('_')
}

/**
 * Converts a string to PascalCase.
 * @example pascalCase('user team') // 'UserTeam'
 */
export function pascalCase(s: string): string {
  return splitWords(s)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

/**
 * Converts a string to dash-case (kebab-case). Optionally capitalizes each segment.
 * @example dashCase('helloWorld') // 'hello-world'
 * @example dashCase('helloWorld', { capitalize: true }) // 'Hello-World'
 */
export function dashCase(s: string, options?: { capitalize?: boolean }): string {
  const words = splitWords(s)
  const segments = options?.capitalize
    ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    : words
  return segments.join('-')
}

/**
 * Converts a string to Title Case.
 * @example titleCase('hello world') // 'Hello World'
 */
export function titleCase(s: string): string {
  return splitWords(s)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Converts a snake_case/camelCase string to a human-readable form.
 * @example humanize('user_name') // 'User name'
 */
export function humanize(s: string): string {
  const words = splitWords(s)
  if (words.length === 0) return ''
  return [words[0]?.charAt(0).toUpperCase() + words[0]?.slice(1), ...words.slice(1)].join(' ')
}

// ---------------------------------------------------------------------------
// Truncation / excerpt
// ---------------------------------------------------------------------------

/**
 * Truncates a string to maxLength characters.
 * @example truncate('Hello world', 8) // 'Hello wo...'
 */
export function truncate(
  text: string,
  maxLength: number,
  options?: { completeWords?: boolean; suffix?: string },
): string {
  const suffix = options?.suffix !== undefined ? options.suffix : '...'
  if (text.length <= maxLength) return text
  const limit = maxLength - suffix.length
  if (limit <= 0) return suffix.slice(0, maxLength)
  if (options?.completeWords) {
    const truncated = text.slice(0, limit)
    const lastSpace = truncated.lastIndexOf(' ')
    return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + suffix
  }
  return text.slice(0, limit) + suffix
}

/**
 * Strips HTML tags then truncates. See `truncate` for options.
 * @example excerpt('<p>Hello world</p>', 8) // 'Hello wo...'
 */
export function excerpt(
  text: string,
  maxLength: number,
  options?: { completeWords?: boolean; suffix?: string },
): string {
  const stripped = text.replace(/<[^>]*>/g, '')
  return truncate(stripped, maxLength, options)
}

// ---------------------------------------------------------------------------
// HTML / escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
}

/**
 * Escapes HTML special characters. Optionally encodes non-ASCII characters as numeric entities.
 * @example escapeHTML('<b>hi</b>') // '&lt;b&gt;hi&lt;/b&gt;'
 */
export function escapeHTML(text: string, options?: { encodeSymbols?: boolean }): string {
  let result = text.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch)
  if (options?.encodeSymbols) {
    result = result.replace(/[\u0080-\uFFFF]/g, (ch) => {
      const code = ch.codePointAt(0)
      return code !== undefined ? `&#x${code.toString(16).toUpperCase()};` : ch
    })
  }
  return result
}

/**
 * Encodes only non-ASCII characters as &#xHEX; numeric entities.
 * @example encodeSymbols('héllo') // 'h&#xE9;llo'
 */
export function encodeSymbols(text: string): string {
  return text.replace(/[\u0080-\uFFFF]/g, (ch) => {
    const code = ch.codePointAt(0)
    return code !== undefined ? `&#x${code.toString(16).toUpperCase()};` : ch
  })
}

// ---------------------------------------------------------------------------
// Whitespace / checks
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is empty or contains only whitespace.
 * @example isEmpty('  ') // true
 */
export function isEmpty(value: string): boolean {
  return value.trim().length === 0
}

/**
 * Trims a string and collapses internal whitespace sequences to a single space.
 * @example condenseWhitespace('  hello   world  ') // 'hello world'
 */
export function condenseWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * Converts a string to a URL-friendly slug.
 * @example slug('Hello World!') // 'hello-world'
 */
export function slug(
  text: string,
  options?: { replacement?: string; lower?: boolean; strict?: boolean },
): string {
  const replacement = options?.replacement !== undefined ? options.replacement : '-'
  const lower = options?.lower !== false
  const strict = options?.strict === true

  let result = lower ? text.toLowerCase() : text

  if (strict) {
    result = result.replace(/[^a-zA-Z0-9\s]/g, '')
  } else {
    result = result.replace(/[^\w\s-]/g, '')
  }

  result = result
    .replace(/[\s_]+/g, replacement)
    .replace(new RegExp(`${escapeForRegex(replacement)}+`, 'g'), replacement)
    .replace(new RegExp(`^${escapeForRegex(replacement)}|${escapeForRegex(replacement)}$`, 'g'), '')

  return result
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Pluralization
// ---------------------------------------------------------------------------

const IRREGULAR_PLURAL: Record<string, string> = {
  person: 'people',
  child: 'children',
  foot: 'feet',
  mouse: 'mice',
  man: 'men',
  woman: 'women',
  tooth: 'teeth',
  goose: 'geese',
  ox: 'oxen',
  leaf: 'leaves',
  half: 'halves',
  knife: 'knives',
  life: 'lives',
  wife: 'wives',
  wolf: 'wolves',
  loaf: 'loaves',
  potato: 'potatoes',
  tomato: 'tomatoes',
  cactus: 'cacti',
  focus: 'foci',
  fungus: 'fungi',
  nucleus: 'nuclei',
  syllabus: 'syllabi',
  analysis: 'analyses',
  diagnosis: 'diagnoses',
  oasis: 'oases',
  thesis: 'theses',
  crisis: 'crises',
  phenomenon: 'phenomena',
  criterion: 'criteria',
  datum: 'data',
}

const IRREGULAR_SINGULAR: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURAL).map(([s, p]) => [p, s]),
)

const UNCOUNTABLE = new Set([
  'sheep',
  'fish',
  'deer',
  'series',
  'species',
  'money',
  'rice',
  'information',
  'equipment',
  'aircraft',
  'police',
])

/**
 * Returns the plural form of an English word.
 * @example plural('person') // 'people'; plural('box') // 'boxes'
 */
export function plural(word: string): string {
  const lower = word.toLowerCase()
  if (UNCOUNTABLE.has(lower)) return word
  const irregular = IRREGULAR_PLURAL[lower]
  if (irregular) return irregular
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  if (/f$/i.test(word)) return `${word.slice(0, -1)}ves`
  if (/fe$/i.test(word)) return `${word.slice(0, -2)}ves`
  return `${word}s`
}

/**
 * Returns the singular form of an English word.
 * @example singular('people') // 'person'; singular('boxes') // 'box'
 */
export function singular(word: string): string {
  const lower = word.toLowerCase()
  if (UNCOUNTABLE.has(lower)) return word
  const irregular = IRREGULAR_SINGULAR[lower]
  if (irregular) return irregular
  if (/ves$/i.test(word)) {
    const base = word.slice(0, -3)
    if (/[lw]$/i.test(base)) return `${base}f`
    return `${base}fe`
  }
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`
  if (/(?:s|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2)
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1)
  return word
}

/**
 * Returns true if the word appears to be plural.
 * @example isPlural('dogs') // true
 */
export function isPlural(word: string): boolean {
  const lower = word.toLowerCase()
  if (UNCOUNTABLE.has(lower)) return true
  return lower !== singular(lower)
}

/**
 * Returns true if the word appears to be singular.
 * @example isSingular('dog') // true
 */
export function isSingular(word: string): boolean {
  const lower = word.toLowerCase()
  if (UNCOUNTABLE.has(lower)) return true
  return singular(lower) === lower
}

// ---------------------------------------------------------------------------
// Random / numeric
// ---------------------------------------------------------------------------

/**
 * Returns a base64url random string of exactly `length` characters.
 * @example random(16) // e.g. 'Xk3mN9pQ2vR7tZ1w'
 */
export function random(length: number): string {
  const bytesNeeded = Math.ceil((length * 3) / 4) + 4
  return randomBytes(bytesNeeded).toString('base64url').slice(0, length)
}

/**
 * Alias for `random`. Generates a base64url random string of `size` characters.
 * @example generateRandom(16) // e.g. 'Xk3mN9pQ2vR7tZ1w'
 */
export function generateRandom(size: number): string {
  return random(size)
}

/**
 * Returns the ordinal representation of a number.
 * @example ordinal(1) // '1st'; ordinal(11) // '11th'; ordinal(22) // '22nd'
 */
export function ordinal(n: number): string {
  const abs = Math.abs(n)
  const mod100 = abs % 100
  const mod10 = abs % 10
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  if (mod10 === 1) return `${n}st`
  if (mod10 === 2) return `${n}nd`
  if (mod10 === 3) return `${n}rd`
  return `${n}th`
}

// ---------------------------------------------------------------------------
// Time / path
// ---------------------------------------------------------------------------

/**
 * Formats an hrtime tuple to a human-readable string.
 * @example prettyHrTime([0, 1234567]) // '1.235 ms'
 * @example prettyHrTime([2, 500000000]) // '2.500 s'
 */
export function prettyHrTime(time: [number, number]): string {
  const [seconds, nanoseconds] = time
  const totalNs = seconds * 1e9 + nanoseconds
  const totalMs = totalNs / 1e6
  const totalS = totalNs / 1e9

  if (totalNs < 1e6) {
    return `${(totalNs / 1e3).toFixed(3)} μs`
  }
  if (totalMs < 1000) {
    return `${totalMs.toFixed(3)} ms`
  }
  if (totalS < 60) {
    return `${totalS.toFixed(3)} s`
  }
  const mins = Math.floor(totalS / 60)
  const secs = totalS - mins * 60
  return `${mins}m ${secs.toFixed(0)}s`
}

/**
 * Converts Windows backslash paths to Unix forward slashes.
 * @example toUnixSlash('C:\\foo\\bar') // 'C:/foo/bar'
 */
export function toUnixSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

/**
 * Interpolates `{{ key.path }}` placeholders in a template string using `data`.
 * Escape with backslash: `\{{` outputs literal `{{`. Missing keys produce empty string.
 *
 * @example
 * interpolate('Hello {{ user.name }}!', { user: { name: 'Alice' } }) // 'Hello Alice!'
 */
export function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(
    /\\(\{\{[\s\S]*?\}\})|(\{\{\s*([\w.]+)\s*\}\})/g,
    (match, escaped: string | undefined, _full: string | undefined, path: string | undefined) => {
      if (escaped !== undefined) return escaped
      if (path === undefined) return match
      const keys = path.split('.')
      let current: unknown = data
      for (const key of keys) {
        if (current === null || current === undefined || typeof current !== 'object') {
          return ''
        }
        current = (current as Record<string, unknown>)[key]
      }
      return current !== null && current !== undefined ? String(current) : ''
    },
  )
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

const string = {
  bytes,
  camelCase,
  snakeCase,
  pascalCase,
  dashCase,
  titleCase,
  humanize,
  truncate,
  excerpt,
  escapeHTML,
  encodeSymbols,
  isEmpty,
  condenseWhitespace,
  slug,
  plural,
  singular,
  isPlural,
  isSingular,
  random,
  generateRandom,
  ordinal,
  prettyHrTime,
  toUnixSlash,
  interpolate,
}

export default string

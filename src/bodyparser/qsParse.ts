/**
 * Bracket-notation form parsing — what AdonisJS gets from `qs`.
 *
 * `@adonisjs/bodyparser` runs `qs.parse(body, options.qs)` on every
 * `application/x-www-form-urlencoded` body, so `user[name]=ada` arrives as
 * `{ user: { name: 'ada' } }` and a repeated `tags[]` becomes an array. Parsing
 * flat instead does not merely lose the nesting: a repeated key OVERWRITES,
 * so a multi-select or a checkbox group silently submits only its last value.
 *
 * Reimplemented rather than depending on `qs` — this package ships no runtime
 * dependency it can write in a screenful, and the limits below are easier to
 * defend when they are visible.
 *
 * Four guards, all of which `qs` also applies:
 *
 *  - **Prototype keys are dropped.** `__proto__[x]=1` in a form body is the
 *    classic prototype-pollution vector; the key never reaches an object.
 *  - **Depth is capped** (`qs` defaults to 5). Beyond it the remainder is kept
 *    as a literal key rather than allocating unbounded nesting.
 *  - **Parameter count is capped** (`qs` defaults to 1000), so a body of a
 *    million `a[0]`, `a[1]`… cannot be turned into a million-entry object.
 *  - **Explicit array indices are capped** (`qs` `arrayLimit`, default 20).
 *    A larger index is an object key, so `ids[4294967294]=1` stays one entry.
 */

/** `qs` defaults, reproduced so the behaviour is the same out of the box. */
export const DEFAULT_DEPTH = 5
export const DEFAULT_PARAMETER_LIMIT = 1000
export const DEFAULT_ARRAY_LIMIT = 20

export interface QsParseOptions {
  /**
   * Treat `user.name` as `user[name]`. AdonisJS forces this ON for form
   * bodies (`queryStringOptions.allowDots ??= true`), so a dotted field name
   * nests there and must nest here.
   */
  allowDots?: boolean
  depth?: number
  parameterLimit?: number
  /**
   * Highest explicit index + 1 that still builds an array (`qs` defaults to
   * 20). `ids[25]=x` becomes `{ ids: { '25': 'x' } }`, so a 16-byte request
   * cannot allocate a 100-million-slot array.
   */
  arrayLimit?: number
  /** Turn `''` into `null`, as AdonisJS' `convertEmptyStringsToNull` does. */
  convertEmptyStringsToNull?: boolean
  /** Trim surrounding whitespace, as AdonisJS' `trimWhitespaces` does. */
  trimWhitespaces?: boolean
}

/** Keys that must never be written onto an object. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Split `user[address][city]` into `['user', 'address', 'city']`, and
 * `tags[]` into `['tags', '']` — an empty segment meaning "append".
 * Segments past `depth` are folded back into one literal key, which is what
 * `qs` does rather than erroring.
 */
function splitKey(key: string, depth: number, allowDots: boolean): string[] {
  // `user.name` → `user[name]` before anything else, so both spellings take
  // the same path. AdonisJS forces allowDots on for form bodies.
  const key2 = allowDots && !key.startsWith('.') ? key.replace(/\.([^.[\]]+)/g, '[$1]') : key
  const firstBracket = key2.indexOf('[')
  if (firstBracket === -1) return [key2]
  const root = key2.slice(0, firstBracket)
  const segments: string[] = [root]
  let rest = key2.slice(firstBracket)
  while (segments.length <= depth) {
    const match = /^\[([^\]]*)\]/.exec(rest)
    if (!match) break
    segments.push(match[1] ?? '')
    rest = rest.slice(match[0].length)
    if (rest.length === 0) return segments
  }
  // Anything left over (too deep, or malformed) stays literal on the last
  // segment — no value is dropped, it is just not nested any further.
  if (rest.length > 0) {
    segments[segments.length - 1] = `${segments[segments.length - 1] ?? ''}${rest}`
  }
  return segments
}

function isIndex(segment: string): boolean {
  return /^\d+$/.test(segment)
}

type Container = Record<string, unknown> | unknown[]

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null
}

/** `{ '0': a, '1': b }` from `[a, b]`, holes left out — what `qs` produces on overflow. */
function arrayToObject(array: unknown[]): Record<string, unknown> {
  const object: Record<string, unknown> = {}
  array.forEach((item, index) => {
    object[String(index)] = item
  })
  return object
}

/**
 * Assign `value` at `segments` inside `target`, creating containers as needed.
 *
 * An explicit index at or above `arrayLimit` never addresses an array: the
 * container becomes (or is converted into) an object keyed by that index,
 * as `qs` does. Without it, `ids[100000000]=1` allocates a sparse array whose
 * iteration or serialisation blocks the event loop for seconds. Appends
 * (`tags[]`, a repeated key) stay arrays — each one costs a parameter, so
 * `parameterLimit` already bounds them, and a long checkbox group keeps the
 * shape its handler expects (`qs` turns those into objects past the limit).
 */
function assign(
  target: Record<string, unknown>,
  segments: string[],
  value: unknown,
  arrayLimit: number,
): void {
  let cursor: Container = target
  // Swaps `cursor` inside its parent when an array has to become an object.
  let replace: (next: Container) => void = () => {}
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? ''
    const last = i === segments.length - 1

    if (FORBIDDEN_KEYS.has(segment)) return

    if (Array.isArray(cursor) && isIndex(segment) && Number(segment) >= arrayLimit) {
      const converted = arrayToObject(cursor)
      replace(converted)
      cursor = converted
    }

    if (last) {
      if (segment === '') {
        // `tags[]` — append.
        if (Array.isArray(cursor)) cursor.push(value)
        return
      }
      if (Array.isArray(cursor)) {
        if (isIndex(segment)) cursor[Number(segment)] = value
        return
      }
      const existing = cursor[segment]
      if (existing === undefined) {
        cursor[segment] = value
        return
      }
      // A key repeated WITHOUT brackets collects too, as `qs` does — losing
      // the earlier value is the bug this whole file exists to fix.
      if (Array.isArray(existing)) existing.push(value)
      else cursor[segment] = [existing, value]
      return
    }

    const nextSegment = segments[i + 1] ?? ''
    const wantsArray =
      nextSegment === '' || (isIndex(nextSegment) && Number(nextSegment) < arrayLimit)

    if (Array.isArray(cursor)) {
      if (!isIndex(segment)) return
      const array: unknown[] = cursor
      const index = Number(segment)
      const existing: unknown = array[index]
      const child: Container = isContainer(existing) ? existing : wantsArray ? [] : {}
      array[index] = child
      replace = (next) => {
        array[index] = next
      }
      cursor = child
      continue
    }

    const object: Record<string, unknown> = cursor
    const existing: unknown = object[segment]
    const child: Container = isContainer(existing) ? existing : wantsArray ? [] : {}
    object[segment] = child
    replace = (next) => {
      object[segment] = next
    }
    cursor = child
  }
}

/**
 * `application/x-www-form-urlencoded` reserves `+` for space (RFC 1866 /
 * WHATWG URL form spec), so the substitution happens BEFORE percent-decoding —
 * otherwise a literal `+` (sent as `%2B`) would become a space too.
 *
 * Malformed percent-encoding makes `decodeURIComponent` throw; the
 * substituted-but-undecoded value is kept so a bad body is a parse miss, not
 * a 500.
 */
export function decodeFormComponent(value: string): string {
  const spaced = value.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

/** Parse a urlencoded body into a nested object. */
export function parseQueryString(
  body: string,
  options: QsParseOptions = {},
): Record<string, unknown> {
  const depth = options.depth ?? DEFAULT_DEPTH
  const parameterLimit = options.parameterLimit ?? DEFAULT_PARAMETER_LIMIT
  const arrayLimit = options.arrayLimit ?? DEFAULT_ARRAY_LIMIT
  const result: Record<string, unknown> = {}
  if (!body) return result

  const pairs = body.split('&')
  let seen = 0
  for (const pair of pairs) {
    if (!pair) continue
    if (++seen > parameterLimit) break

    const eqIdx = pair.indexOf('=')
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx)
    const rawValue = eqIdx === -1 ? '' : pair.slice(eqIdx + 1)

    const key = decodeFormComponent(rawKey)
    let value: unknown = decodeFormComponent(rawValue)
    if (options.trimWhitespaces && typeof value === 'string') value = value.trim()
    if (options.convertEmptyStringsToNull && value === '') value = null

    assign(result, splitKey(key, depth, options.allowDots ?? true), value, arrayLimit)
  }
  return result
}

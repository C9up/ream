/**
 * Rich HTTP test response — `helix`'s `ApiResponse` parity.
 *
 * Wraps the raw {@link TestResponse} and exposes the full helix response surface:
 * accessor METHODS (`status()`, `headers()`, `body()`, `text()`, `header()`,
 * `cookies()`, `redirects()`, `error()`, …) matching helix exactly, the complete
 * `assert*` family, response `dump*()` debuggers, and `macro()`/`getter()` for
 * consumer extension.
 *
 * `json()` is kept as an additive convenience (not in helix, but harmless for
 * parity — helix code never calls it) so `res.json()` call sites need no change.
 */

import type { Dict } from '../types/helpers.js'

/** The raw response shape the low-level sender produces. */
export interface TestResponse {
  status: number
  headers: Dict
  body: string
  json<T = unknown>(): T
}

/** Assertion failure — plain Error so tests see a clean stack trace. */
export class ExpectationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpectationError'
  }
}

export function capBody(s: string, max = 512): string {
  return s.length <= max ? s : `${s.slice(0, max)}...[truncated]`
}

/** Narrowing guard — a non-null, non-array object usable as a string map. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Exact structural equality (order-insensitive object keys) for `assertBody`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
}

/**
 * Partial deep-match. For objects, every key in `expected` must match in
 * `actual`. For arrays, every element in `expected` must match SOMEWHERE in
 * `actual` (order-independent). Primitives compared by strict equality.
 */
export function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) {
    return actual === expected
  }
  if (typeof expected !== 'object') return actual === expected
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    return expected.every((want) => actual.some((have) => partialMatch(have, want)))
  }
  if (!isRecord(actual) || !isRecord(expected)) return false
  for (const key of Object.keys(expected)) {
    if (!partialMatch(actual[key], expected[key])) return false
  }
  return true
}

/** Split a `Set-Cookie` header value into its individual cookie strings. */
function splitSetCookie(setCookie: string): string[] {
  return setCookie.split(/,(?=\s*[\w-]+=)/).map((c) => c.trim())
}

/** A parsed response cookie — `name` + `value` plus any attributes present. */
export interface ResponseCookie {
  name: string
  value: string
  [attr: string]: string
}

function parseCookies(setCookie: string | undefined): Record<string, ResponseCookie> {
  const out: Record<string, ResponseCookie> = {}
  if (!setCookie) return out
  for (const raw of splitSetCookie(setCookie)) {
    const segments = raw.split(';')
    const first = segments[0] ?? ''
    const eq = first.indexOf('=')
    if (eq === -1) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    const cookie: ResponseCookie = { name, value }
    for (const attr of segments.slice(1)) {
      const aEq = attr.indexOf('=')
      if (aEq === -1) cookie[attr.trim().toLowerCase()] = ''
      else cookie[attr.slice(0, aEq).trim().toLowerCase()] = attr.slice(aEq + 1).trim()
    }
    out[name] = cookie
  }
  return out
}

/** A file parsed from a `multipart/form-data` response — helix `files()` entry. */
export interface ResponseFile {
  /** The form field name. */
  fieldName: string
  /** The advertised filename. */
  filename: string
  /** The part's `Content-Type`. */
  type: string
  /** Byte length of the file content. */
  size: number
  /** The raw file bytes. */
  content: Buffer
}

/** Consumer-registered response parsers (helix `ApiRequest.addParser`), by content-type. */
const responseParsers = new Map<string, (body: string, headers: Dict) => unknown>()

/**
 * Parse a `multipart/form-data` response body (RFC 7578) into its non-file
 * `fields` and its `files`. Best-effort; a malformed part is skipped.
 */
function parseMultipartResponse(
  body: string,
  contentType: string,
): { fields: Record<string, string>; files: Record<string, ResponseFile> } {
  const fields: Record<string, string> = {}
  const files: Record<string, ResponseFile> = {}
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim()
  if (!boundary) return { fields, files }
  const buf = Buffer.from(body, 'binary')
  const delim = Buffer.from(`--${boundary}`, 'utf8')
  const parts = splitBuffer(buf, delim)
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headerText = part.subarray(0, headerEnd).toString('utf8')
    // Trim the trailing CRLF before the next boundary.
    let content = part.subarray(headerEnd + 4)
    if (content.subarray(-2).toString('binary') === '\r\n') content = content.subarray(0, -2)
    const [, name] = headerText.match(/name="([^"]*)"/i) ?? []
    if (name === undefined) continue
    const [, filename] = headerText.match(/filename="([^"]*)"/i) ?? []
    if (filename !== undefined) {
      const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i)
      files[name] = {
        fieldName: name,
        filename,
        type: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
        size: content.length,
        content,
      }
    } else {
      fields[name] = content.toString('utf8')
    }
  }
  return { fields, files }
}

/** Split a buffer on a delimiter (used by the multipart parser). */
function splitBuffer(buf: Buffer, delim: Buffer): Buffer[] {
  const out: Buffer[] = []
  let start = 0
  let idx = buf.indexOf(delim, start)
  while (idx !== -1) {
    if (idx > start) out.push(buf.subarray(start, idx))
    start = idx + delim.length
    idx = buf.indexOf(delim, start)
  }
  if (start < buf.length) out.push(buf.subarray(start))
  // Drop the leading preamble + trailing `--` epilogue fragments.
  return out.filter((p) => {
    const s = p.subarray(0, 2).toString('binary')
    return s !== '--' && p.length > 4
  })
}

/**
 * Validator for `assertAgainstApiSpec()` — mirrors helix's OpenAPI plugin, which
 * is a SEPARATE opt-in (`a separate OpenAPI-assertions plugin`). Register one to enable spec
 * assertions; without it, the assertion throws a clear "not configured" error
 * rather than silently passing.
 */
let apiSpecValidator: ((res: ApiResponse) => void) | undefined

/** Tolerant JSON parse for assertions (independent of the response content-type). */
function jsonOf(raw: TestResponse): unknown {
  try {
    return raw.json()
  } catch (err) {
    throw new ExpectationError(
      `Expected JSON body, got non-JSON. Body: ${capBody(raw.body)} (parse error: ${err instanceof Error ? err.message : String(err)})`,
    )
  }
}

/** The helix error object returned by `response.error()`. */
export interface ResponseError {
  /** The error status code (>= 400). */
  status: number
  /** The response text. */
  text: string
}

/** Extra context the builder threads into the response. */
export interface ApiResponseMeta {
  /** The (final) request method — helix `response.method()`. */
  method?: string
  /** URLs followed when redirects were configured — helix `response.redirects()`. */
  redirects?: string[]
}

/**
 * Every helix status-shortcut assertion, as `methodName → code`. Consumed to
 * generate the `assert*` methods on both {@link ApiResponse} and the builder,
 * so the two surfaces never drift.
 */
export const STATUS_ASSERTIONS = {
  assertOk: 200,
  assertCreated: 201,
  assertAccepted: 202,
  assertNoContent: 204,
  assertMovedPermanently: 301,
  assertFound: 302,
  assertBadRequest: 400,
  assertUnauthorized: 401,
  assertPaymentRequired: 402,
  assertForbidden: 403,
  assertNotFound: 404,
  assertMethodNotAllowed: 405,
  assertNotAcceptable: 406,
  assertRequestTimeout: 408,
  assertConflict: 409,
  assertGone: 410,
  assertLengthRequired: 411,
  assertPreconditionFailed: 412,
  assertPayloadTooLarge: 413,
  assertURITooLong: 414,
  assertUnsupportedMediaType: 415,
  assertRangeNotSatisfiable: 416,
  assertImATeapot: 418,
  assertUnprocessableEntity: 422,
  assertLocked: 423,
  assertTooManyRequests: 429,
  /** ream extra (not in helix's list, kept for convenience). */
  assertInternalServerError: 500,
} as const

/** Consumer-registered macros/getters (helix `ApiResponse.macro`/`.getter`). */
const responseMacros = new Map<string, unknown>()
const responseGetters = new Map<string, (this: ApiResponse, res: ApiResponse) => unknown>()

/**
 * The rich response. Constructed by the request builder from a raw
 * {@link TestResponse}; exposes the helix accessor + assertion surface.
 *
 * PARITY NOTE: the status code / headers / raw text are METHODS — `status()`,
 * `headers()`, `text()` — and `body()` returns the content-type-parsed body,
 * exactly like helix. `json()` is kept as an additive convenience.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the StatusAssertions interface below types the status shortcuts attached to the prototype from STATUS_ASSERTIONS — every member is implemented, so the merge is safe.
export class ApiResponse {
  readonly #raw: TestResponse
  readonly #method: string
  readonly #redirects: string[]

  constructor(raw: TestResponse, meta: ApiResponseMeta = {}) {
    this.#raw = raw
    this.#method = meta.method ?? 'GET'
    this.#redirects = meta.redirects ?? []
    applyResponseExtensions(this)
  }

  // ── helix accessors (method form) ─────────────────────────────────────────

  /** HTTP status code — helix `status()`. */
  status(): number {
    return this.#raw.status
  }

  /** Status class digit (2 for 2xx, 4 for 4xx, …) — helix `statusType()`. */
  statusType(): number {
    return Math.floor(this.#raw.status / 100)
  }

  /** All response headers (lower-cased keys) — helix `headers()`. */
  headers(): Dict {
    return this.#raw.headers
  }

  /** A single response header value — helix `header(name)`. */
  header(name: string): string | undefined {
    return this.#raw.headers[name.toLowerCase()]
  }

  /** Raw response text — helix `text()`. */
  text(): string {
    return this.#raw.body
  }

  /**
   * The parsed response body — helix `body()`. Parses by `Content-Type`:
   * `application/json` → object, `application/x-www-form-urlencoded` → object,
   * `multipart/form-data` → the non-file fields (files come from {@link files});
   * otherwise the raw text. A registered parser (`ApiResponse.addParser`) for the
   * content-type takes precedence.
   */
  body(): unknown {
    const ct = (this.#raw.headers['content-type'] ?? '').toLowerCase()
    const text = this.#raw.body
    const type = ct.split(';')[0]?.trim() ?? ''
    const custom = responseParsers.get(type)
    if (custom) return custom(text, this.#raw.headers)
    if (ct.includes('application/json')) {
      return text.length > 0 ? JSON.parse(text) : undefined
    }
    if (ct.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text))
    }
    if (ct.includes('multipart/form-data')) {
      // Pass the ORIGINAL-case header — multipart boundaries are case-sensitive.
      return parseMultipartResponse(text, this.#raw.headers['content-type'] ?? '').fields
    }
    return text
  }

  /** Convenience JSON parse (additive; not in helix). */
  json<T = unknown>(): T {
    return JSON.parse(this.#raw.body) as T
  }

  /** The request method that produced this response — helix `method()`. */
  method(): string {
    return this.#method
  }

  /** Response `Content-Type` without parameters — helix `type()`. */
  type(): string | undefined {
    const ct = this.#raw.headers['content-type']
    return ct ? (ct.split(';')[0]?.trim() ?? ct) : undefined
  }

  /** Charset from `Content-Type`, if any — helix `charset()`. */
  charset(): string | undefined {
    const ct = this.#raw.headers['content-type'] ?? ''
    const [, charset] = ct.match(/charset=([^;]+)/i) ?? []
    return charset?.trim()
  }

  /** All response cookies, parsed from `Set-Cookie` — helix `cookies()`. */
  cookies(): Record<string, ResponseCookie> {
    return parseCookies(this.#raw.headers['set-cookie'])
  }

  /** A single parsed response cookie — helix `cookie(name)`. */
  cookie(name: string): ResponseCookie | undefined {
    return this.cookies()[name]
  }

  /** URLs followed for a redirected request — helix `redirects()`. */
  redirects(): string[] {
    return [...this.#redirects]
  }

  /** Parsed `Link` header (`rel → url`) — helix `links()`. */
  links(): Record<string, string> {
    const link = this.#raw.headers.link
    if (!link) return {}
    const out: Record<string, string> = {}
    for (const part of link.split(',')) {
      const [, url, rel] = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/) ?? []
      if (url !== undefined && rel !== undefined) out[rel] = url
    }
    return out
  }

  /**
   * Files parsed from a `multipart/form-data` response — helix `files()`. Each
   * entry carries the field name, filename, content-type and the raw bytes.
   * Empty for non-multipart responses.
   */
  files(): Record<string, ResponseFile> {
    const ctRaw = this.#raw.headers['content-type'] ?? ''
    if (!ctRaw.toLowerCase().includes('multipart/form-data')) return {}
    // Pass the ORIGINAL-case header — multipart boundaries are case-sensitive.
    return parseMultipartResponse(this.#raw.body, ctRaw).files
  }

  /** Whether the response carries a body — helix `hasBody()`. */
  hasBody(): boolean {
    return this.#raw.body.length > 0
  }

  /** Whether the status is an error (>= 400) — helix `hasError()`. */
  hasError(): boolean {
    return this.#raw.status >= 400
  }

  /** Whether the status is a server error (>= 500) — helix `hasFatalError()`. */
  hasFatalError(): boolean {
    return this.#raw.status >= 500
  }

  /**
   * The error object when the response is an error, else `undefined` — helix
   * `error()`. Exposes `.status` and `.text` (superagent-style).
   */
  error(): ResponseError | undefined {
    if (!this.hasError()) return undefined
    return { status: this.#raw.status, text: this.#raw.body }
  }

  // ── Debugging (helix response `dump*`) ────────────────────────────────────

  /** Print status + headers + body to stderr — helix `response.dump()`. */
  dump(): this {
    process.stderr.write(
      `[helix:response.dump] ${this.#method} → ${this.#raw.status}\n` +
        `headers: ${JSON.stringify(this.#raw.headers, null, 2)}\n` +
        `body: ${capBody(this.#raw.body, 2048)}\n`,
    )
    return this
  }
  /** Print only the response body — helix `response.dumpBody()`. */
  dumpBody(): this {
    process.stderr.write(`[helix:response.dumpBody] ${capBody(this.#raw.body, 2048)}\n`)
    return this
  }
  /** Print only the response headers — helix `response.dumpHeaders()`. */
  dumpHeaders(): this {
    process.stderr.write(
      `[helix:response.dumpHeaders] ${JSON.stringify(this.#raw.headers, null, 2)}\n`,
    )
    return this
  }
  /** Print only the response cookies — helix `response.dumpCookies()`. */
  dumpCookies(): this {
    process.stderr.write(
      `[helix:response.dumpCookies] ${JSON.stringify(this.cookies(), null, 2)}\n`,
    )
    return this
  }
  /** Print the error object, if any — helix `response.dumpError()`. */
  dumpError(): this {
    process.stderr.write(`[helix:response.dumpError] ${JSON.stringify(this.error(), null, 2)}\n`)
    return this
  }

  // ── Assertions (immediate; each returns `this`) ──────────────────────────

  assertStatus(code: number): this {
    if (this.#raw.status !== code) {
      throw new ExpectationError(
        `Expected status ${code}, got ${this.#raw.status}. Body: ${capBody(this.#raw.body)}`,
      )
    }
    return this
  }

  assertHeader(name: string, value?: string | RegExp): this {
    const actual = this.#raw.headers[name.toLowerCase()]
    if (actual === undefined) {
      throw new ExpectationError(
        `Expected header ${name}, not present in: ${Object.keys(this.#raw.headers).join(', ')}`,
      )
    }
    if (value === undefined) return this
    if (value instanceof RegExp) {
      if (!value.test(actual)) {
        throw new ExpectationError(`Expected header ${name} to match ${value}, got "${actual}"`)
      }
    } else if (actual !== value) {
      throw new ExpectationError(`Expected header ${name} = "${value}", got "${actual}"`)
    }
    return this
  }

  assertHeaderMissing(name: string): this {
    if (this.#raw.headers[name.toLowerCase()] !== undefined) {
      throw new ExpectationError(`Expected header ${name} to be absent, but it was present.`)
    }
    return this
  }

  assertCookie(name: string, value?: string | RegExp): this {
    const cookie = this.cookies()[name]
    if (!cookie) {
      throw new ExpectationError(
        `Expected cookie ${name}, not found in Set-Cookie: ${this.#raw.headers['set-cookie'] ?? '(none)'}`,
      )
    }
    if (value === undefined) return this
    if (value instanceof RegExp) {
      if (!value.test(cookie.value)) {
        throw new ExpectationError(
          `Expected cookie ${name} to match ${value}, got "${cookie.value}"`,
        )
      }
    } else if (cookie.value !== value) {
      throw new ExpectationError(`Expected cookie ${name} = "${value}", got "${cookie.value}"`)
    }
    return this
  }

  assertCookieMissing(name: string): this {
    if (this.cookies()[name]) {
      throw new ExpectationError(`Expected cookie ${name} to be absent, but it was set.`)
    }
    return this
  }

  /**
   * The body used by `assertBody*`, parsed per `Content-Type` (helix parity):
   * urlencoded/multipart → the structured `body()`; JSON or an unknown/absent
   * content-type → a tolerant JSON parse (so bodyless test fakes keep working).
   */
  #assertionBody(): unknown {
    const ct = (this.#raw.headers['content-type'] ?? '').toLowerCase()
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      return this.body()
    }
    return jsonOf(this.#raw)
  }

  assertBody(expected: unknown): this {
    const actual = this.#assertionBody()
    if (!deepEqual(actual, expected)) {
      throw new ExpectationError(
        `Expected body to equal.\nExpected: ${JSON.stringify(expected)}\nActual: ${capBody(JSON.stringify(actual))}`,
      )
    }
    return this
  }

  assertBodyContains(subset: unknown): this {
    const actual = this.#assertionBody()
    if (!partialMatch(actual, subset)) {
      throw new ExpectationError(
        `Expected body to contain subset.\nSubset: ${JSON.stringify(subset)}\nActual: ${capBody(JSON.stringify(actual))}`,
      )
    }
    return this
  }

  assertBodyNotContains(subset: unknown): this {
    const actual = this.#assertionBody()
    if (partialMatch(actual, subset)) {
      throw new ExpectationError(
        `Expected body NOT to contain subset, but it did.\nSubset: ${JSON.stringify(subset)}\nActual: ${capBody(JSON.stringify(actual))}`,
      )
    }
    return this
  }

  assertTextIncludes(substring: string): this {
    if (!this.#raw.body.includes(substring)) {
      throw new ExpectationError(
        `Expected response text to include ${JSON.stringify(substring)}.\nActual: ${capBody(this.#raw.body)}`,
      )
    }
    return this
  }

  /**
   * Assert the request was redirected to `path` — helix `assertRedirectsTo`.
   * Checks the followed redirect chain (`redirects()`); also accepts a direct
   * 3xx `Location` match when no redirects were followed.
   */
  assertRedirectsTo(path: string): this {
    const pathOf = (loc: string) =>
      loc.startsWith('http') ? new URL(loc).pathname : (loc.split('?')[0] ?? loc)
    if (this.#redirects.some((loc) => pathOf(loc) === path)) return this
    const location = this.#raw.headers.location
    if (
      this.#raw.status >= 300 &&
      this.#raw.status < 400 &&
      location &&
      pathOf(location) === path
    ) {
      return this
    }
    const chain = this.#redirects.length > 0 ? this.#redirects.map(pathOf).join(', ') : '(none)'
    throw new ExpectationError(
      `Expected redirect to "${path}". Followed: ${chain}; final status ${this.#raw.status}` +
        (location ? `, Location "${location}"` : ''),
    )
  }

  /**
   * Assert the response conforms to the registered OpenAPI spec — helix
   * `assertAgainstApiSpec()`. helix ships this via the SEPARATE opt-in
   * `a separate OpenAPI-assertions plugin` plugin; register a validator with
   * {@link ApiResponse.registerApiSpecValidator} to enable it. Without one, this
   * throws (never silently passes).
   */
  assertAgainstApiSpec(): this {
    if (!apiSpecValidator) {
      throw new ExpectationError(
        'assertAgainstApiSpec() requires an OpenAPI validator. Register one via ' +
          'ApiResponse.registerApiSpecValidator(fn) (the opt-in equivalent of a separate OpenAPI-assertions plugin).',
      )
    }
    apiSpecValidator(this)
    return this
  }

  /**
   * Register a shared property (helix `ApiResponse.macro`) or lazy getter
   * (`ApiResponse.getter`). The callback is invoked with `this` bound to the
   * response AND the response as its first argument, so both helix's
   * `function () { return this.header('x') }` and `(res) => res.header('x')` work.
   */
  static macro(name: string, value: unknown): void {
    responseMacros.set(name, value)
  }
  static getter(name: string, fn: (this: ApiResponse, res: ApiResponse) => unknown): void {
    responseGetters.set(name, fn)
  }

  /** Register a response body parser for a content-type — helix `ApiRequest.addParser`. */
  static addParser(contentType: string, fn: (body: string, headers: Dict) => unknown): void {
    responseParsers.set(contentType, fn)
  }

  /** Register the validator backing {@link assertAgainstApiSpec} (OpenAPI opt-in). */
  static registerApiSpecValidator(fn: (res: ApiResponse) => void): void {
    apiSpecValidator = fn
  }
}

// The status-shortcut assertions are attached to the prototype from the shared
// map so ApiResponse and the builder can never disagree on the code set.
for (const [method, code] of Object.entries(STATUS_ASSERTIONS)) {
  Object.defineProperty(ApiResponse.prototype, method, {
    value(this: ApiResponse) {
      return this.assertStatus(code)
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

/** The status-shortcut assertion methods, typed onto ApiResponse + the builder. */
export type StatusAssertions<T> = {
  [K in keyof typeof STATUS_ASSERTIONS]: () => T
}

// Merge the generated status-shortcut methods into the ApiResponse type.
export interface ApiResponse extends StatusAssertions<ApiResponse> {}

/** Apply registered macros/getters onto a freshly built response. */
function applyResponseExtensions(res: ApiResponse): void {
  for (const [name, value] of responseMacros) {
    Object.defineProperty(res, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  for (const [name, fn] of responseGetters) {
    let computed = false
    let cached: unknown
    Object.defineProperty(res, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (!computed) {
          // `this`-bound AND passed as arg → both `function(){this.x}` and `(res)=>res.x` work.
          cached = fn.call(res, res)
          computed = true
        }
        return cached
      },
    })
  }
}

import type { TestResponse } from './TestClient.js'

/**
 * Fluent HTTP request builder with assertion methods (japa/api-client model).
 *
 *   await client
 *     .get('/api/users/42')
 *     .withAuth(user)
 *     .assertOk()
 *     .assertBody({ id: 42 })
 *
 * The builder chains SYNCHRONOUSLY: setters and assertion methods both return
 * `this`. Assertions are LAZY — each registers a check; the request is sent
 * once and every check runs, in order, when the builder is awaited (it is
 * thenable, so `await builder` resolves to the response). A plain `await
 * client.get('/x')` (no assertion) just sends and returns the response.
 */

export interface AuthSubject {
  /** String or numeric user id — used by `withAuth` / `asUser` to sign the session. */
  id: string | number
  /** Optional custom headers added to the request (e.g. tenant markers). */
  extraHeaders?: Record<string, string>
}

export interface AuthStrategy {
  /** Compute the headers Warden expects for this user (Bearer token / session cookie / ...). */
  headersFor(subject: AuthSubject): Record<string, string> | Promise<Record<string, string>>
  /** Compute cookies for session-based strategies. */
  cookiesFor?(subject: AuthSubject): Record<string, string> | Promise<Record<string, string>>
}

/** Assertion failure — plain Error so tests see a clean stack trace. */
class ExpectationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpectationError'
  }
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Cookie the signed CSRF token is issued in (blackhole default: `XSRF-TOKEN`). */
const CSRF_COOKIE_NAME = 'XSRF-TOKEN'
/** Header the client echoes the token back in (Axios/Angular default). */
const CSRF_HEADER_NAME = 'x-xsrf-token'

/** Content-type / accept shorthands — mirrors japa/api-client's `.type()`/`.accept()`. */
const TYPE_SHORTHANDS: Record<string, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  urlencoded: 'application/x-www-form-urlencoded',
  text: 'text/plain',
  html: 'text/html',
  xml: 'application/xml',
}

/** Expand a shorthand (`'json'`) to a full MIME type, or pass a full type through. */
function resolveMime(type: string): string {
  return TYPE_SHORTHANDS[type] ?? type
}

/** Primitive accepted as a query-string value (mirrors `.qs()` in japa/api-client). */
type QueryValue = string | number | boolean
/** Query-string map — a value or an array of values (repeated key). */
export type QueryParams = Record<string, QueryValue | ReadonlyArray<QueryValue>>

/**
 * Internal low-level sender — matches what the TestClient exposes.
 * Accepting it as an injected callable keeps RequestBuilder framework-agnostic.
 */
export type HttpSender = (
  method: HttpMethod,
  path: string,
  init: {
    headers: Record<string, string>
    body: Buffer
  },
) => Promise<TestResponse>

/** Options for a multipart file part — mirrors Adonis/japa's `.file()` options. */
export interface FilePart {
  /** Filename advertised in the part's `Content-Disposition`. Defaults to the field name. */
  filename?: string
  /** MIME type of the part. Defaults to `application/octet-stream`. */
  contentType?: string
}

/** One encoded multipart/form-data part — a text field or an uploaded file. */
type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; contentType: string; content: Buffer }

export class RequestBuilder {
  #sender: HttpSender
  #method: HttpMethod
  #path: string
  #headers: Record<string, string> = {}
  #body: Buffer = Buffer.alloc(0)
  #multipart: MultipartPart[] = []
  #cookies: Record<string, string> = {}
  #query = new URLSearchParams()
  #authStrategy: AuthStrategy | null
  #pendingAuth: AuthSubject | null = null
  #sent: Promise<TestResponse> | null = null
  // Lazy assertions (japa model): each `assert*`/`expect*` registers a check and
  // returns `this` synchronously; the checks run in order when the builder is
  // awaited (`then`) — after the single send. So `await client.get('/x')
  // .assertOk().assertBody(y)` sends once and runs both.
  #checks: Array<(res: TestResponse) => void> = []

  constructor(
    sender: HttpSender,
    method: HttpMethod,
    path: string,
    authStrategy: AuthStrategy | null = null,
  ) {
    this.#sender = sender
    this.#method = method
    this.#path = path
    this.#authStrategy = authStrategy
  }

  headers(map: Record<string, string>): this {
    for (const [k, v] of Object.entries(map)) {
      this.#headers[k.toLowerCase()] = v
    }
    return this
  }

  header(name: string, value: string): this {
    this.#headers[name.toLowerCase()] = value
    return this
  }

  json(data: unknown): this {
    this.#body = Buffer.from(JSON.stringify(data), 'utf8')
    this.#headers['content-type'] = 'application/json'
    return this
  }

  body(data: Buffer | string, contentType?: string): this {
    this.#body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (contentType) this.#headers['content-type'] = contentType
    return this
  }

  form(data: Record<string, string>): this {
    const pairs = Object.entries(data).map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    this.#body = Buffer.from(pairs.join('&'), 'utf8')
    this.#headers['content-type'] = 'application/x-www-form-urlencoded'
    return this
  }

  /**
   * Add a `multipart/form-data` text field — mirrors Adonis/japa's `.field()`.
   * Calling `.field()` or `.file()` switches the body to multipart (use
   * `.form()` for `application/x-www-form-urlencoded`). The boundary +
   * `Content-Type` header are produced at send time.
   */
  field(name: string, value: string): this {
    this.#multipart.push({ kind: 'field', name, value })
    return this
  }

  /**
   * Attach a file as a `multipart/form-data` part — mirrors Adonis/japa's
   * `.file(field, contents, { filename, contentType })`. `contents` is a
   * Buffer (binary) or a string (encoded as utf8). Server-side
   * `request.file(field, …)` reads the resulting part.
   */
  file(field: string, contents: Buffer | string, options: FilePart = {}): this {
    this.#multipart.push({
      kind: 'file',
      name: field,
      filename: options.filename ?? field,
      contentType: options.contentType ?? 'application/octet-stream',
      content: typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents,
    })
    return this
  }

  cookies(map: Record<string, string>): this {
    Object.assign(this.#cookies, map)
    return this
  }

  cookie(name: string, value: string): this {
    this.#cookies[name] = value
    return this
  }

  /**
   * Append query-string params — mirrors japa/api-client's `.qs()`. Values are
   * URL-encoded; arrays repeat the key (`?tag=a&tag=b`). Merges with any query
   * string already on the path and with earlier `.qs()` calls.
   */
  qs(params: QueryParams): this {
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) this.#query.append(key, String(item))
      } else {
        this.#query.append(key, String(value))
      }
    }
    return this
  }

  /** Pass a bearer token as the `Authorization` header — japa `.bearerToken()`. */
  bearerToken(token: string): this {
    this.#headers.authorization = `Bearer ${token}`
    return this
  }

  /** Pass HTTP Basic credentials as the `Authorization` header — japa `.basicAuth()`. */
  basicAuth(user: string, password: string): this {
    const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
    this.#headers.authorization = `Basic ${encoded}`
    return this
  }

  /**
   * Set the request `Content-Type` from a shorthand (`'json'`, `'form'`, …) or a
   * full MIME type — mirrors japa/api-client's `.type()`. Prefer `json()`/`form()`
   * when you also set the body; `.type()` is for overriding the type only.
   */
  type(mime: string): this {
    this.#headers['content-type'] = resolveMime(mime)
    return this
  }

  /**
   * Set the `Accept` header from a shorthand (`'json'`, `'html'`, …) or a full
   * MIME type — mirrors japa/api-client's `.accept()`.
   */
  accept(mime: string): this {
    this.#headers.accept = resolveMime(mime)
    return this
  }

  /**
   * Satisfy blackhole's signed double-submit CSRF check: echo the `XSRF-TOKEN`
   * cookie back in the `X-XSRF-TOKEN` header (the pair the server compares).
   *
   * With a `token` argument, sets both the cookie and the header — useful when
   * you already hold a signed token. Without one, reads the token from a cookie
   * set earlier on this request (typically extracted from a prior safe GET's
   * `Set-Cookie`); throws if none is present so the mistake is caught at the
   * call site instead of surfacing as a confusing 403.
   */
  withCsrf(token?: string): this {
    if (token !== undefined) this.#cookies[CSRF_COOKIE_NAME] = token
    const value = this.#cookies[CSRF_COOKIE_NAME]
    if (value === undefined) {
      throw new Error(
        `RequestBuilder: withCsrf() found no '${CSRF_COOKIE_NAME}' cookie. Set it first via ` +
          `.cookie('${CSRF_COOKIE_NAME}', token) (extracted from a prior safe GET) or pass the token: withCsrf(token).`,
      )
    }
    this.#headers[CSRF_HEADER_NAME] = value
    return this
  }

  /** japa/api-client's spelling of {@link withCsrf}. */
  withCsrfToken(token?: string): this {
    return this.withCsrf(token)
  }

  /**
   * Attach auth for a user. Uses the strategy passed to `client`'s `auth`
   * option — Warden's session/JWT/API-key strategy decides the header/cookie
   * shape. Without a strategy, throws at send time.
   */
  withAuth(subject: AuthSubject): this {
    this.#pendingAuth = subject
    return this
  }

  /** Shortcut for `withAuth({ id: userId })` — user is identified by id only. */
  asUser(userId: string | number): this {
    this.#pendingAuth = { id: userId }
    return this
  }

  /** Fire the request (once) and return the raw response. Idempotent. */
  send(): Promise<TestResponse> {
    if (this.#sent === null) this.#sent = this.#execute()
    return this.#sent
  }

  /**
   * Thenable — `await client.get('/x')` sends the request and resolves to the
   * response (Japa/api-client parity), so the fluent assertion surface and a
   * plain `await` share ONE builder. (Assertion methods return `Promise<this>`;
   * awaiting one resolves via this `then` to the response — a single assertion
   * per `await`, which is the documented pattern.)
   */
  then<R1 = TestResponse, R2 = never>(
    onFulfilled?: ((value: TestResponse) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#settle().then(onFulfilled, onRejected)
  }

  /** Send once, then run every registered assertion (throws on first failure). */
  async #settle(): Promise<TestResponse> {
    const res = await this.send()
    for (const check of this.#checks) check(res)
    return res
  }

  /** Register a lazy assertion; returns `this` for synchronous chaining. */
  #assert(check: (res: TestResponse) => void): this {
    this.#checks.push(check)
    return this
  }

  expectStatus(code: number): this {
    return this.#assert((res) => {
      if (res.status !== code) {
        throw new ExpectationError(
          `Expected status ${code}, got ${res.status}. Body: ${capBody(res.body)}`,
        )
      }
    })
  }

  expectHeader(name: string, value: string | RegExp): this {
    return this.#assert((res) => {
      const actual = res.headers[name.toLowerCase()]
      if (actual === undefined) {
        throw new ExpectationError(
          `Expected header ${name}, not present in response headers: ${Object.keys(res.headers).join(', ')}`,
        )
      }
      if (value instanceof RegExp) {
        if (!value.test(actual)) {
          throw new ExpectationError(`Expected header ${name} to match ${value}, got "${actual}"`)
        }
      } else if (actual !== value) {
        throw new ExpectationError(`Expected header ${name} = "${value}", got "${actual}"`)
      }
    })
  }

  expectCookie(name: string, value?: string | RegExp): this {
    return this.#assert((res) => {
      const setCookie = res.headers['set-cookie']
      if (!setCookie) {
        throw new ExpectationError(`Expected cookie ${name}, but no Set-Cookie header was returned`)
      }
      const match = setCookie
        .split(/,(?=\s*\w+=)/)
        .find((c) => c.trimStart().startsWith(`${name}=`))
      if (!match) {
        throw new ExpectationError(`Expected cookie ${name}, not found in: ${setCookie}`)
      }
      if (value === undefined) return
      const rawVal = match.split(';')[0]?.split('=')[1] ?? ''
      if (value instanceof RegExp) {
        if (!value.test(rawVal)) {
          throw new ExpectationError(`Expected cookie ${name} to match ${value}, got "${rawVal}"`)
        }
      } else if (rawVal !== value) {
        throw new ExpectationError(`Expected cookie ${name} = "${value}", got "${rawVal}"`)
      }
    })
  }

  expectJson(expected: unknown): this {
    return this.#assert((res) => {
      const actual = jsonOf(res)
      if (!partialMatch(actual, expected)) {
        throw new ExpectationError(
          `JSON partial match failed.\nExpected (partial): ${JSON.stringify(expected)}\nActual: ${capBody(JSON.stringify(actual))}`,
        )
      }
    })
  }

  // japa/api-client status shortcuts — register via expectStatus, return `this`.
  assertOk(): this {
    return this.expectStatus(200)
  }
  assertCreated(): this {
    return this.expectStatus(201)
  }
  assertNoContent(): this {
    return this.expectStatus(204)
  }
  assertBadRequest(): this {
    return this.expectStatus(400)
  }
  assertUnauthorized(): this {
    return this.expectStatus(401)
  }
  assertForbidden(): this {
    return this.expectStatus(403)
  }
  assertNotFound(): this {
    return this.expectStatus(404)
  }
  assertStatus(code: number): this {
    return this.expectStatus(code)
  }
  assertAccepted(): this {
    return this.expectStatus(202)
  }
  assertMethodNotAllowed(): this {
    return this.expectStatus(405)
  }
  assertConflict(): this {
    return this.expectStatus(409)
  }
  assertUnprocessableEntity(): this {
    return this.expectStatus(422)
  }
  assertTooManyRequests(): this {
    return this.expectStatus(429)
  }
  assertInternalServerError(): this {
    return this.expectStatus(500)
  }

  /** Assert a redirect (3xx) whose `Location` pathname resolves to `path`. */
  assertRedirectsTo(path: string): this {
    return this.#assert((res) => {
      if (res.status < 300 || res.status >= 400) {
        throw new ExpectationError(
          `Expected a redirect (3xx) to "${path}", got status ${res.status}.`,
        )
      }
      const location = res.headers.location
      if (location === undefined) {
        throw new ExpectationError(
          `Expected a redirect to "${path}", but the response has no Location header.`,
        )
      }
      const actual = location.startsWith('http')
        ? new URL(location).pathname
        : (location.split('?')[0] ?? location)
      if (actual !== path) {
        throw new ExpectationError(`Expected redirect to "${path}", got "${actual}".`)
      }
    })
  }

  /** Assert the JSON body contains `subset` (deep partial) — japa `assertBodyContains`. */
  assertBodyContains(subset: unknown): this {
    return this.#assert((res) => {
      const actual = jsonOf(res)
      if (!partialMatch(actual, subset)) {
        throw new ExpectationError(
          `Expected body to contain subset.\nSubset: ${JSON.stringify(subset)}\nActual: ${capBody(JSON.stringify(actual))}`,
        )
      }
    })
  }

  /** Assert the JSON body does NOT contain `subset` — japa `assertBodyNotContains`. */
  assertBodyNotContains(subset: unknown): this {
    return this.#assert((res) => {
      const actual = jsonOf(res)
      if (partialMatch(actual, subset)) {
        throw new ExpectationError(
          `Expected body NOT to contain subset, but it did.\nSubset: ${JSON.stringify(subset)}\nActual: ${capBody(JSON.stringify(actual))}`,
        )
      }
    })
  }

  /** Assert the JSON body EXACTLY equals `expected` (deep equality) — japa `assertBody`. */
  assertBody(expected: unknown): this {
    return this.#assert((res) => {
      const actual = jsonOf(res)
      if (!deepEqual(actual, expected)) {
        throw new ExpectationError(
          `Expected body to equal.\nExpected: ${JSON.stringify(expected)}\nActual: ${capBody(JSON.stringify(actual))}`,
        )
      }
    })
  }

  /** Assert the raw response text includes `substring` — japa `assertTextIncludes`. */
  assertTextIncludes(substring: string): this {
    return this.#assert((res) => {
      if (!res.body.includes(substring)) {
        throw new ExpectationError(
          `Expected response text to include ${JSON.stringify(substring)}.\nActual: ${capBody(res.body)}`,
        )
      }
    })
  }

  /** Print status/headers/body to stderr for debugging — japa `.dump()`. */
  dump(): this {
    return this.#assert((res) => {
      process.stderr.write(
        `[helix:dump] ${this.#method} ${this.#path} → ${res.status}\n` +
          `headers: ${JSON.stringify(res.headers, null, 2)}\n` +
          `body: ${capBody(res.body, 2048)}\n`,
      )
    })
  }

  /** Assert a header is present, and equals `value` when given (presence-only otherwise). */
  assertHeader(name: string, value?: string): this {
    if (value !== undefined) return this.expectHeader(name, value)
    return this.#assert((res) => {
      if (res.headers[name.toLowerCase()] === undefined) {
        throw new ExpectationError(
          `Expected header ${name}, not present in: ${Object.keys(res.headers).join(', ')}`,
        )
      }
    })
  }

  /** Assert a response header is absent — japa `assertHeaderMissing`. */
  assertHeaderMissing(name: string): this {
    return this.#assert((res) => {
      if (res.headers[name.toLowerCase()] !== undefined) {
        throw new ExpectationError(`Expected header ${name} to be absent, but it was present.`)
      }
    })
  }

  /** Assert the response set a cookie, optionally with a given value — japa `assertCookie`. */
  assertCookie(name: string, value?: string): this {
    return this.expectCookie(name, value)
  }

  /** Assert the response did NOT set a cookie — japa `assertCookieMissing`. */
  assertCookieMissing(name: string): this {
    return this.#assert((res) => {
      const setCookie = res.headers['set-cookie']
      if (setCookie) {
        const present = setCookie
          .split(/,(?=\s*\w+=)/)
          .some((c) => c.trimStart().startsWith(`${name}=`))
        if (present) {
          throw new ExpectationError(
            `Expected cookie ${name} to be absent, but it was set: ${setCookie}`,
          )
        }
      }
    })
  }

  async #execute(): Promise<TestResponse> {
    // Resolve auth before sending.
    if (this.#pendingAuth !== null) {
      if (!this.#authStrategy) {
        throw new Error(
          'RequestBuilder: `withAuth()` / `asUser()` called but no AuthStrategy was provided via the client `auth` option.',
        )
      }
      const authHeaders = await this.#authStrategy.headersFor(this.#pendingAuth)
      for (const [k, v] of Object.entries(authHeaders)) {
        this.#headers[k.toLowerCase()] = v
      }
      if (this.#authStrategy.cookiesFor) {
        const authCookies = await this.#authStrategy.cookiesFor(this.#pendingAuth)
        Object.assign(this.#cookies, authCookies)
      }
      if (this.#pendingAuth.extraHeaders) {
        for (const [k, v] of Object.entries(this.#pendingAuth.extraHeaders)) {
          this.#headers[k.toLowerCase()] = v
        }
      }
    }

    // Multipart parts (.field()/.file()) take precedence over any body set by
    // json()/form()/body(); encode them with a fresh boundary at send time.
    if (this.#multipart.length > 0) {
      const boundary = `----ReamRequestBuilder${crypto.randomUUID().replace(/-/g, '')}`
      this.#body = encodeMultipart(this.#multipart, boundary)
      this.#headers['content-type'] = `multipart/form-data; boundary=${boundary}`
    }

    // Serialise cookies into a single `Cookie:` header.
    const cookieEntries = Object.entries(this.#cookies)
    if (cookieEntries.length > 0) {
      this.#headers.cookie = cookieEntries.map(([k, v]) => `${k}=${v}`).join('; ')
    }

    // Merge `.qs()` params into the path, preserving any query string it
    // already carries.
    let path = this.#path
    const qs = this.#query.toString()
    if (qs) {
      path += (path.includes('?') ? '&' : '?') + qs
    }

    return this.#sender(this.#method, path, {
      headers: this.#headers,
      body: this.#body,
    })
  }
}

function jsonOf(res: TestResponse): unknown {
  try {
    return res.json()
  } catch (err) {
    throw new ExpectationError(
      `Expected JSON body, got non-JSON. Body: ${capBody(res.body)} (parse error: ${err instanceof Error ? err.message : String(err)})`,
    )
  }
}

function capBody(s: string, max = 512): string {
  return s.length <= max ? s : `${s.slice(0, max)}...[truncated]`
}

/** Strip CR/LF and escape quotes so a name/filename can't break the headers. */
function sanitizeHeaderParam(value: string): string {
  return value.replace(/[\r\n]/g, '').replace(/"/g, '%22')
}

/** Encode multipart/form-data parts (RFC 7578) into a single body Buffer. */
function encodeMultipart(parts: MultipartPart[], boundary: string): Buffer {
  const CRLF = '\r\n'
  const chunks: Buffer[] = []
  for (const part of parts) {
    if (part.kind === 'field') {
      chunks.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${sanitizeHeaderParam(part.name)}"${CRLF}${CRLF}` +
            `${part.value}${CRLF}`,
          'utf8',
        ),
      )
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${sanitizeHeaderParam(part.name)}"; filename="${sanitizeHeaderParam(part.filename)}"${CRLF}` +
            `Content-Type: ${part.contentType}${CRLF}${CRLF}`,
          'utf8',
        ),
        part.content,
        Buffer.from(CRLF, 'utf8'),
      )
    }
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))
  return Buffer.concat(chunks)
}

/** Narrowing guard — a non-null, non-array object usable as a string map. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Partial deep-match. For objects, every key in `expected` must match in
 * `actual`. For arrays, every element in `expected` must match SOMEWHERE in
 * `actual` (order-independent). Primitives compared by strict equality.
 */
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

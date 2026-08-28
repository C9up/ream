/**
 * Fluent HTTP request builder with assertion methods (`helix` model).
 *
 *   await client
 *     .get('/api/users/42')
 *     .withAuth(user)
 *     .assertOk()
 *     .assertBody({ id: 42 })
 *
 * The builder chains SYNCHRONOUSLY: setters and assertion methods both return
 * `this`. Assertions are LAZY — each registers a check; the request is sent once
 * and every check runs, in order, when the builder is awaited (it is thenable,
 * so `await builder` resolves to the {@link ApiResponse}). A plain
 * `await client.get('/x')` (no assertion) just sends and returns the response.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import {
  ApiResponse,
  capBody,
  ExpectationError,
  partialMatch,
  STATUS_ASSERTIONS,
  type StatusAssertions,
  type TestResponse,
} from './ApiResponse.js'

// Re-export the shared response types + matchers so `@c9up/ream/testing`
// consumers keep importing them from here (back-compat).
export {
  ApiResponse,
  deepEqual,
  partialMatch,
  type ResponseCookie,
  type ResponseError,
  type ResponseFile,
  type TestResponse,
} from './ApiResponse.js'

export interface AuthSubject {
  /** String or numeric user id — used by `withAuth` / `asUser` to sign the session. */
  id: string | number
  /** Optional custom headers added to the request (e.g. tenant markers). */
  extraHeaders?: Record<string, string>
}

/**
 * What a guard answers when asked to authenticate a test client
 * (AdonisJS `AuthClientResponse`).
 */
export interface ClientAuthResponse {
  headers?: Record<string, string>
  session?: Record<string, unknown>
  cookies?: Record<string, string>
}

/**
 * The little `loginAs()` needs of a guard.
 *
 * Structurally typed: the test client must not import warden, and an app with
 * its own guard satisfies this by exposing the same method.
 */
export interface ClientAuthenticatable {
  authenticateAsClient(...args: never[]): ClientAuthResponse | Promise<ClientAuthResponse>
}

/**
 * Persists session values for a test request and returns the cookie that
 * addresses them. Given the session driver, it writes an entry and hands back
 * `{ <cookieName>: <sessionId> }`.
 */
export type SessionSeeder = (
  values: Record<string, unknown>,
) => Record<string, string> | Promise<Record<string, string>>

export interface AuthStrategy {
  /** Compute the headers Warden expects for this user (Bearer token / session cookie / ...). */
  headersFor(subject: AuthSubject): Record<string, string> | Promise<Record<string, string>>
  /** Compute cookies for session-based strategies. */
  cookiesFor?(subject: AuthSubject): Record<string, string> | Promise<Record<string, string>>
}

/**
 * HTTP methods. The common verbs are named; `request(url, method)` also accepts
 * any other method (e.g. `TRACE`, `CONNECT`) — helix parity — via the wider
 * string fallback.
 */
export type HttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'TRACE'
  | 'CONNECT'
  | (string & {})

/** Cookie the signed CSRF token is issued in (blackhole default: `XSRF-TOKEN`). */
const CSRF_COOKIE_NAME = 'XSRF-TOKEN'
/** Header the client echoes the token back in (Axios/Angular default). */
const CSRF_HEADER_NAME = 'x-xsrf-token'

/** Content-type / accept shorthands — mirrors helix's `.type()`/`.accept()`. */
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

/** Primitive accepted as a query-string value (mirrors `.qs()` in helix). */
type QueryValue = string | number | boolean
/** Query-string map — a value or an array of values (repeated key). */
export type QueryParams = Record<string, QueryValue | ReadonlyArray<QueryValue>>

/** A scalar accepted by `form()`/`fields()` — helix parity (arrays repeat the key). */
export type FieldValue = string | number | boolean | Buffer
/** A value accepted by a multipart `field()`/`file()` — helix parity (incl. streams/blobs). */
export type MultipartValue = string | number | boolean | Buffer | Blob | Readable

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
    /** Per-request socket timeout (ms) — helix `.timeout()`. Sender may honour it. */
    timeoutMs?: number
  },
) => Promise<TestResponse>

/** Options for a multipart file part — mirrors Adonis/helix's `.file()` options. */
export interface FilePart {
  /** Filename advertised in the part's `Content-Disposition`. Defaults to the field name / basename. */
  filename?: string
  /** MIME type of the part. Defaults to `application/octet-stream`. */
  contentType?: string
}

/**
 * One multipart/form-data part — a field or an uploaded file. The value/content
 * may be a stream/blob; it is resolved to a Buffer at send time (`#execute`).
 */
type MultipartPart =
  | { kind: 'field'; name: string; value: MultipartValue }
  | { kind: 'file'; name: string; filename: string; contentType: string; content: MultipartValue }

/** HTTP statuses that trigger redirect-following (helix `.redirects()`). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** helix follows 5 redirects by default. */
const DEFAULT_MAX_REDIRECTS = 5

/** Consumer-registered macros/getters (helix `ApiRequest.macro`/`.getter`). */
const requestMacros = new Map<string, unknown>()
const requestGetters = new Map<string, (this: RequestBuilder, req: RequestBuilder) => unknown>()
/** Consumer-registered request body serializers (helix `ApiRequest.addSerializer`), by name. */
const requestSerializers = new Map<
  string,
  (data: unknown) => { body: Buffer; contentType: string }
>()

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the merged interface (StatusAssertions) types the status-shortcut asserts attached from STATUS_ASSERTIONS at load — the same generated-method pattern as EonSchema/Macroable (AdonisJS parity); every member is implemented, so the merge is safe.
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
  #sessionSeeder: SessionSeeder | null
  #pendingAuth: AuthSubject | null = null
  #pendingClientAuth: {
    guard: ClientAuthenticatable
    args: never[]
  } | null = null
  #timeoutMs: number | undefined
  #maxRedirects = DEFAULT_MAX_REDIRECTS
  #sent: Promise<ApiResponse> | null = null
  // Lazy assertions (helix model): each `assert*`/`expect*` registers a check and
  // returns `this` synchronously; the checks run in order when the builder is
  // awaited (`then`) — after the single send.
  #checks: Array<(res: ApiResponse) => void> = []

  constructor(
    sender: HttpSender,
    method: HttpMethod,
    path: string,
    authStrategy: AuthStrategy | null = null,
    sessionSeeder: SessionSeeder | null = null,
  ) {
    this.#sender = sender
    this.#method = method
    this.#path = path
    this.#authStrategy = authStrategy
    this.#sessionSeeder = sessionSeeder
    applyRequestExtensions(this)
  }

  headers(map: Record<string, string>): this {
    for (const [k, v] of Object.entries(map)) {
      this.#headers[k.toLowerCase()] = v
    }
    return this
  }

  header(name: string, value: string | string[]): this {
    // helix accepts string | string[]; a list is joined into one header value.
    this.#headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
    return this
  }

  json(data: unknown): this {
    this.#body = Buffer.from(JSON.stringify(data), 'utf8')
    this.#headers['content-type'] = 'application/json'
    return this
  }

  /** helix `.unsafeJson()` — set a JSON body without any transform (alias of {@link json}). */
  unsafeJson(data: unknown): this {
    return this.json(data)
  }

  body(data: Buffer | string, contentType?: string): this {
    this.#body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (contentType) this.#headers['content-type'] = contentType
    return this
  }

  form(data: Record<string, FieldValue | FieldValue[]>): this {
    // Array values repeat the key (`a=1&a=2`) — helix parity.
    const pairs: string[] = []
    for (const [k, v] of Object.entries(data)) {
      const values = Array.isArray(v) ? v : [v]
      for (const item of values) {
        pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(fieldToString(item))}`)
      }
    }
    this.#body = Buffer.from(pairs.join('&'), 'utf8')
    this.#headers['content-type'] = 'application/x-www-form-urlencoded'
    return this
  }

  /** helix `.unsafeForm()` — set a urlencoded body without transform (alias of {@link form}). */
  unsafeForm(data: Record<string, FieldValue | FieldValue[]>): this {
    return this.form(data)
  }

  /**
   * Add a `multipart/form-data` field — mirrors Adonis/helix's `.field()`. Accepts
   * a string/number/boolean, a Buffer, a Blob, a Readable stream, or an array of
   * these (repeated part). Calling `.field()`/`.fields()`/`.file()` switches the
   * body to multipart; the boundary + `Content-Type` header are produced at send
   * time (streams/blobs are drained to Buffers then).
   */
  field(name: string, value: MultipartValue | MultipartValue[]): this {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      this.#multipart.push({
        kind: 'field',
        name,
        value: isScalar(v) ? fieldToString(v) : v,
      })
    }
    return this
  }

  /** Add several multipart fields at once — helix `.fields()`. */
  fields(map: Record<string, MultipartValue | MultipartValue[]>): this {
    for (const [name, value] of Object.entries(map)) {
      this.field(name, value)
    }
    return this
  }

  /**
   * Attach a file as a `multipart/form-data` part — mirrors Adonis/helix's
   * `.file(field, value, { filename, contentType })`. `value` is a Buffer, a
   * Blob, a Readable stream, OR a string absolute PATH to a file on disk (read at
   * call time, helix parity). The filename defaults to the path basename / field
   * name; streams/blobs are drained to Buffers at send time.
   */
  file(field: string, value: Buffer | string | Blob | Readable, options: FilePart = {}): this {
    // A string is a PATH → read now; other kinds are resolved at send time.
    const content: MultipartValue = typeof value === 'string' ? readFileSync(value) : value
    const filename = options.filename ?? (typeof value === 'string' ? basename(value) : field)
    this.#multipart.push({
      kind: 'file',
      name: field,
      filename,
      contentType: options.contentType ?? 'application/octet-stream',
      content,
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
   * Append query-string params — mirrors helix's `.qs()`. Values are
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

  /**
   * Append query params WITHOUT any validation/normalisation — helix
   * `.unsafeQs({ … })`. Values are still URL-encoded so the wire stays valid, but
   * (unlike `.qs()`) no key filtering is applied; arrays repeat the key.
   */
  unsafeQs(params: QueryParams): this {
    return this.qs(params)
  }

  /** Pass a bearer token as the `Authorization` header — helix `.bearerToken()`. */
  bearerToken(token: string): this {
    this.#headers.authorization = `Bearer ${token}`
    return this
  }

  /** Pass HTTP Basic credentials as the `Authorization` header — helix `.basicAuth()`. */
  basicAuth(user: string, password: string): this {
    const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
    this.#headers.authorization = `Basic ${encoded}`
    return this
  }

  /**
   * Set the request `Content-Type` from a shorthand (`'json'`, `'form'`, …) or a
   * full MIME type — mirrors helix's `.type()`.
   */
  type(mime: string): this {
    this.#headers['content-type'] = resolveMime(mime)
    return this
  }

  /**
   * Set the `Accept` header from a shorthand (`'json'`, `'html'`, …) or a full
   * MIME type — mirrors helix's `.accept()`.
   */
  accept(mime: string): this {
    this.#headers.accept = resolveMime(mime)
    return this
  }

  /** Per-request timeout in ms — helix `.timeout()`. Honoured by the sender. */
  timeout(ms: number): this {
    this.#timeoutMs = ms
    return this
  }

  /**
   * Follow up to `count` redirects before resolving — helix `.redirects()`.
   * Defaults to 5 (helix default); pass `0` to disable following.
   */
  redirects(count: number): this {
    this.#maxRedirects = Math.max(0, count)
    return this
  }

  // TLS knobs — helix parity. The test server is plain HTTP over loopback, so
  // these are inert (there is no TLS handshake to configure); they exist so
  // helix-shaped code type-checks and runs unchanged. NAMED as a ream deviation.
  /** No-op: the loopback test server has no TLS — helix `.trustLocalhost()`. */
  trustLocalhost(_trust = true): this {
    return this
  }
  /** No-op: no TLS on the loopback test server — helix `.ca()`. */
  ca(_cert: string): this {
    return this
  }
  /** No-op: no TLS on the loopback test server — helix `.cert()`. */
  cert(_chain: string): this {
    return this
  }
  /** No-op: no TLS on the loopback test server — helix `.privateKey()`. */
  privateKey(_key: string): this {
    return this
  }
  /** No-op: no TLS on the loopback test server — helix `.pfx()`. */
  pfx(_encoded: string | Buffer): this {
    return this
  }
  /** No-op: no TLS on the loopback test server — helix `.disableTLSCerts()`. */
  disableTLSCerts(): this {
    return this
  }

  /**
   * Satisfy blackhole's signed double-submit CSRF check: echo the `XSRF-TOKEN`
   * cookie back in the `X-XSRF-TOKEN` header (the pair the server compares).
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

  /** helix's spelling of {@link withCsrf}. */
  withCsrfToken(token?: string): this {
    return this.withCsrf(token)
  }

  /**
   * Attach auth for a user. Uses the strategy passed to `client`'s `auth`
   * option. Without a strategy, throws at send time.
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

  /**
   * Send this request as an authenticated user (AdonisJS `loginAs`).
   *
   *     await client.get('/dashboard').loginAs(sessionGuard, user)
   *     await client.get('/api/me').loginAs(jwtGuard, user)
   *     await client.get('/admin').loginAs(basicGuard, 'ada', 'secret')
   *
   * The GUARD answers what to send — a header, a session entry, a cookie — so
   * the test never reproduces how that guard authenticates. A test that forges
   * its own header proves only that the forgery works; this one travels the
   * same verification path as production.
   */
  loginAs(guard: ClientAuthenticatable, ...args: never[]): this {
    this.#pendingClientAuth = { guard, args }
    return this
  }

  /** Fire the request (once) and return the rich response. Idempotent. */
  send(): Promise<ApiResponse> {
    if (this.#sent === null) this.#sent = this.#execute()
    return this.#sent
  }

  /**
   * Thenable — `await client.get('/x')` sends the request and resolves to the
   * {@link ApiResponse} (helix parity). Assertion methods return `this`;
   * awaiting one resolves via this `then` to the response after running the checks.
   */
  // biome-ignore lint/suspicious/noThenProperty: the thenable IS the public API — `await client.get('/x')` is the documented helix ergonomic; removing `.then` breaks every await-the-builder call site.
  then<R1 = ApiResponse, R2 = never>(
    onFulfilled?: ((value: ApiResponse) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#settle().then(onFulfilled, onRejected)
  }

  /** Send once, then run every registered assertion (throws on first failure). */
  async #settle(): Promise<ApiResponse> {
    const res = await this.send()
    for (const check of this.#checks) check(res)
    return res
  }

  /** Register a lazy assertion; returns `this` for synchronous chaining. */
  #assert(check: (res: ApiResponse) => void): this {
    this.#checks.push(check)
    return this
  }

  // ── ream-flavoured `expect*` aliases (kept for back-compat) ───────────────

  expectStatus(code: number): this {
    return this.#assert((res) => res.assertStatus(code))
  }
  expectHeader(name: string, value: string | RegExp): this {
    return this.#assert((res) => res.assertHeader(name, value))
  }
  expectCookie(name: string, value?: string | RegExp): this {
    return this.#assert((res) => res.assertCookie(name, value))
  }
  expectJson(expected: unknown): this {
    // ream alias: partial JSON match with its own message (kept for back-compat;
    // `assertBodyContains` is the helix-named equivalent).
    return this.#assert((res) => {
      if (!partialMatch(res.json(), expected)) {
        throw new ExpectationError(
          `JSON partial match failed.\nExpected (partial): ${JSON.stringify(expected)}\nActual: ${capBody(JSON.stringify(res.json()))}`,
        )
      }
    })
  }

  // ── helix assertions (lazy — delegate to the response) ─────────────────────

  assertStatus(code: number): this {
    return this.#assert((res) => res.assertStatus(code))
  }
  assertHeader(name: string, value?: string | RegExp): this {
    return this.#assert((res) => res.assertHeader(name, value))
  }
  assertHeaderMissing(name: string): this {
    return this.#assert((res) => res.assertHeaderMissing(name))
  }
  assertCookie(name: string, value?: string | RegExp): this {
    return this.#assert((res) => res.assertCookie(name, value))
  }
  assertCookieMissing(name: string): this {
    return this.#assert((res) => res.assertCookieMissing(name))
  }
  assertBody(expected: unknown): this {
    return this.#assert((res) => res.assertBody(expected))
  }
  assertBodyContains(subset: unknown): this {
    return this.#assert((res) => res.assertBodyContains(subset))
  }
  assertBodyNotContains(subset: unknown): this {
    return this.#assert((res) => res.assertBodyNotContains(subset))
  }
  assertTextIncludes(substring: string): this {
    return this.#assert((res) => res.assertTextIncludes(substring))
  }
  assertRedirectsTo(path: string): this {
    return this.#assert((res) => res.assertRedirectsTo(path))
  }

  // ── Request debugging (helix `request.dump*` — dumps the REQUEST) ──────────

  /** Print the pending request (method/path/headers/body) — helix `request.dump()`. */
  dump(): this {
    process.stderr.write(
      `[helix:request.dump] ${this.#method} ${this.#path}\n` +
        `headers: ${JSON.stringify(this.#headers, null, 2)}\n` +
        `cookies: ${JSON.stringify(this.#cookies, null, 2)}\n` +
        `body: ${capBody(this.#body.toString('utf8'), 2048)}\n`,
    )
    return this
  }
  /** Print only the pending request body — helix `request.dumpBody()`. */
  dumpBody(): this {
    process.stderr.write(`[helix:request.dumpBody] ${capBody(this.#body.toString('utf8'), 2048)}\n`)
    return this
  }
  /** Print only the pending request headers — helix `request.dumpHeaders()`. */
  dumpHeaders(): this {
    process.stderr.write(`[helix:request.dumpHeaders] ${JSON.stringify(this.#headers, null, 2)}\n`)
    return this
  }
  /** Print only the pending request cookies — helix `request.dumpCookies()`. */
  dumpCookies(): this {
    process.stderr.write(`[helix:request.dumpCookies] ${JSON.stringify(this.#cookies, null, 2)}\n`)
    return this
  }

  async #execute(): Promise<ApiResponse> {
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

    if (this.#pendingClientAuth !== null) {
      const { guard, args } = this.#pendingClientAuth
      const answer = await guard.authenticateAsClient(...args)
      for (const [k, v] of Object.entries(answer.headers ?? {})) {
        this.#headers[k.toLowerCase()] = v
      }
      Object.assign(this.#cookies, answer.cookies ?? {})
      // A session guard answers with session VALUES, which only something
      // holding the session driver can persist. Without a seeder the request
      // would go out unauthenticated and the test would fail somewhere far from
      // the cause — so say it here instead.
      if (answer.session && Object.keys(answer.session).length > 0) {
        if (!this.#sessionSeeder) {
          throw new Error(
            'RequestBuilder: `loginAs()` was given a session-based guard, which needs a session to be written before the request. ' +
              'Pass `sessionSeeder` in the client options (it receives the values and returns the session cookie).',
          )
        }
        const cookie = await this.#sessionSeeder(answer.session)
        Object.assign(this.#cookies, cookie)
      }
    }

    // Multipart parts (.field()/.file()) take precedence over any body set by
    // json()/form()/body(); encode them with a fresh boundary at send time.
    if (this.#multipart.length > 0) {
      const boundary = `----ReamRequestBuilder${crypto.randomUUID().replace(/-/g, '')}`
      // Drain any stream/blob part to a Buffer before encoding (helix parity).
      const resolved: ResolvedPart[] = await Promise.all(
        this.#multipart.map(async (p) =>
          p.kind === 'field'
            ? { kind: 'field' as const, name: p.name, value: await toBuffer(p.value) }
            : {
                kind: 'file' as const,
                name: p.name,
                filename: p.filename,
                contentType: p.contentType,
                content: await toBuffer(p.content),
              },
        ),
      )
      this.#body = encodeMultipart(resolved, boundary)
      this.#headers['content-type'] = `multipart/form-data; boundary=${boundary}`
    }

    // Serialise cookies into a single `Cookie:` header.
    const cookieEntries = Object.entries(this.#cookies)
    if (cookieEntries.length > 0) {
      this.#headers.cookie = cookieEntries.map(([k, v]) => `${k}=${v}`).join('; ')
    }

    // Merge `.qs()` params into the path, preserving any existing query string.
    let path = this.#path
    const qs = this.#query.toString()
    if (qs) {
      path += (path.includes('?') ? '&' : '?') + qs
    }

    let method = this.#method
    let body = this.#body
    let raw = await this.#sender(method, path, {
      headers: this.#headers,
      body,
      timeoutMs: this.#timeoutMs,
    })

    // Follow redirects up to the configured budget — helix `.redirects()` (5 by default).
    const chain: string[] = []
    let followed = 0
    while (
      followed < this.#maxRedirects &&
      REDIRECT_STATUSES.has(raw.status) &&
      raw.headers.location !== undefined
    ) {
      const location = raw.headers.location
      chain.push(location)
      followed += 1
      path = location.startsWith('http')
        ? new URL(location).pathname + new URL(location).search
        : location
      // 303 (and, per browser convention, 301/302) switch to GET with no body;
      // 307/308 preserve the method and body.
      if (raw.status === 307 || raw.status === 308) {
        // keep method + body
      } else {
        method = 'GET'
        body = Buffer.alloc(0)
        delete this.#headers['content-type']
      }
      raw = await this.#sender(method, path, {
        headers: this.#headers,
        body,
        timeoutMs: this.#timeoutMs,
      })
    }

    return new ApiResponse(raw, { method, redirects: chain })
  }

  /**
   * Serialize `data` with a registered serializer and set it as the request body
   * — the send-side twin of {@link ApiResponse.addParser}. Register serializers
   * via {@link RequestBuilder.addSerializer} (helix `ApiRequest.addSerializer`).
   */
  serialize(name: string, data: unknown): this {
    const serializer = requestSerializers.get(name)
    if (!serializer) {
      throw new Error(
        `RequestBuilder: no serializer registered for "${name}" (see RequestBuilder.addSerializer).`,
      )
    }
    const { body, contentType } = serializer(data)
    this.#body = body
    this.#headers['content-type'] = contentType
    return this
  }

  /**
   * Register a shared property (helix `ApiRequest.macro`) or lazy getter
   * (`ApiRequest.getter`). The callback is invoked with `this` bound to the
   * builder AND the builder as its first arg, so both helix's
   * `function () { return this.header('x') }` and `(req) => …` work.
   */
  static macro(name: string, value: unknown): void {
    requestMacros.set(name, value)
  }
  static getter(name: string, fn: (this: RequestBuilder, req: RequestBuilder) => unknown): void {
    requestGetters.set(name, fn)
  }

  /** Register a request body serializer — helix `ApiRequest.addSerializer`. */
  static addSerializer(
    name: string,
    fn: (data: unknown) => { body: Buffer; contentType: string },
  ): void {
    requestSerializers.set(name, fn)
  }

  /** Register a response body parser — helix `ApiRequest.addParser` (delegates to ApiResponse). */
  static addParser(
    contentType: string,
    fn: (body: string, headers: Record<string, string>) => unknown,
  ): void {
    ApiResponse.addParser(contentType, fn)
  }
}

/** The status-shortcut assertions (lazy) are typed onto the builder. */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the merged interface (StatusAssertions) types the status-shortcut asserts attached from STATUS_ASSERTIONS at load — the same generated-method pattern as EonSchema/Macroable (AdonisJS parity); every member is implemented, so the merge is safe.
export interface RequestBuilder extends StatusAssertions<RequestBuilder> {}

// Attach the lazy status-shortcut assertions from the shared map so the builder
// and ApiResponse never disagree on the code set. Each defers to the public
// `expectStatus` (private fields aren't reachable from prototype-added fns).
for (const [method, code] of Object.entries(STATUS_ASSERTIONS)) {
  Object.defineProperty(RequestBuilder.prototype, method, {
    value(this: RequestBuilder) {
      return this.expectStatus(code)
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })
}

/** Coerce a field value to its wire string (Buffers are handled separately). */
function fieldToString(value: FieldValue): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

/** Whether a multipart value is a scalar (string/number/boolean/Buffer), not a stream/blob. */
function isScalar(v: MultipartValue): v is FieldValue {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Buffer.isBuffer(v)
  )
}

/** Drain a multipart value (string/Buffer/Blob/Readable) to a Buffer at send time. */
async function toBuffer(v: MultipartValue): Promise<Buffer> {
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'string') return Buffer.from(v, 'utf8')
  if (typeof v === 'number' || typeof v === 'boolean') return Buffer.from(String(v), 'utf8')
  // `in` narrows the Blob | Readable union without a cast: only Blob has arrayBuffer.
  if ('arrayBuffer' in v) return Buffer.from(await v.arrayBuffer())
  // Readable / async-iterable → collect chunks.
  const chunks: Buffer[] = []
  for await (const chunk of v) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** A multipart part whose value/content has been resolved to a Buffer (send time). */
type ResolvedPart =
  | { kind: 'field'; name: string; value: Buffer }
  | { kind: 'file'; name: string; filename: string; contentType: string; content: Buffer }

/** Apply registered request macros/getters onto a freshly built builder. */
function applyRequestExtensions(req: RequestBuilder): void {
  for (const [name, value] of requestMacros) {
    Object.defineProperty(req, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  for (const [name, fn] of requestGetters) {
    let computed = false
    let cached: unknown
    Object.defineProperty(req, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (!computed) {
          // `this`-bound AND passed as arg → both `function(){this.x}` and `(req)=>req.x` work.
          cached = fn.call(req, req)
          computed = true
        }
        return cached
      },
    })
  }
}

/** Strip CR/LF and escape quotes so a name/filename can't break the headers. */
function sanitizeHeaderParam(value: string): string {
  return value.replace(/[\r\n]/g, '').replace(/"/g, '%22')
}

/** Encode resolved multipart/form-data parts (RFC 7578) into a single body Buffer. */
function encodeMultipart(parts: ResolvedPart[], boundary: string): Buffer {
  const CRLF = '\r\n'
  const chunks: Buffer[] = []
  for (const part of parts) {
    if (part.kind === 'field') {
      const valueBuf = part.value
      chunks.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${sanitizeHeaderParam(part.name)}"${CRLF}${CRLF}`,
          'utf8',
        ),
        valueBuf,
        Buffer.from(CRLF, 'utf8'),
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

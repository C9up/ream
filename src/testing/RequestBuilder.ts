import type { TestResponse } from './TestClient.js'

/**
 * Fluent HTTP request builder with assertion methods.
 *
 *   await client
 *     .fluent('GET', '/api/users/42')
 *     .withAuth(user)
 *     .expectStatus(200)
 *     .expectJson({ id: 42 })
 *
 * The builder chains: setters return `this`, assertion methods send the
 * request on first call (memoised) and return a `Promise<this>` so further
 * assertions can be awaited or chained via `await`.
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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

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
  #authStrategy: AuthStrategy | null
  #pendingAuth: AuthSubject | null = null
  #sent: Promise<TestResponse> | null = null

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

  async expectStatus(code: number): Promise<this> {
    const res = await this.send()
    if (res.status !== code) {
      throw new ExpectationError(
        `Expected status ${code}, got ${res.status}. Body: ${capBody(res.body)}`,
      )
    }
    return this
  }

  async expectHeader(name: string, value: string | RegExp): Promise<this> {
    const res = await this.send()
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
    return this
  }

  async expectCookie(name: string, value?: string | RegExp): Promise<this> {
    const res = await this.send()
    const setCookie = res.headers['set-cookie']
    if (!setCookie) {
      throw new ExpectationError(`Expected cookie ${name}, but no Set-Cookie header was returned`)
    }
    const cookies = setCookie.split(/,(?=\s*\w+=)/)
    const match = cookies.find((c) => c.trimStart().startsWith(`${name}=`))
    if (!match) {
      throw new ExpectationError(`Expected cookie ${name}, not found in: ${setCookie}`)
    }
    if (value === undefined) return this
    const rawVal = match.split(';')[0]?.split('=')[1] ?? ''
    if (value instanceof RegExp) {
      if (!value.test(rawVal)) {
        throw new ExpectationError(`Expected cookie ${name} to match ${value}, got "${rawVal}"`)
      }
    } else if (rawVal !== value) {
      throw new ExpectationError(`Expected cookie ${name} = "${value}", got "${rawVal}"`)
    }
    return this
  }

  async expectJson(expected: unknown): Promise<this> {
    const res = await this.send()
    let actual: unknown
    try {
      actual = res.json()
    } catch (err) {
      throw new ExpectationError(
        `Expected JSON body, got non-JSON. Body: ${capBody(res.body)} (parse error: ${err instanceof Error ? err.message : String(err)})`,
      )
    }
    if (!partialMatch(actual, expected)) {
      throw new ExpectationError(
        `JSON partial match failed.\nExpected (partial): ${JSON.stringify(expected)}\nActual: ${capBody(JSON.stringify(actual))}`,
      )
    }
    return this
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

    return this.#sender(this.#method, this.#path, {
      headers: this.#headers,
      body: this.#body,
    })
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

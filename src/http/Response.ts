/**
 * Response — accumulates HTTP response state with a fluent API.
 *
 * Wraps the same { status, headers, body } wire format expected by the NAPI layer.
 * Provides AdonisJS-compatible methods: json(), send(), status(), header(), etc.
 *
 * @implements FR21
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import etag from 'etag'
import { contentType } from 'mime-types'
import type { CookieSigner } from '../security/CookieSigner.js'
import { Macroable } from '../utils/Macroable.js'
import { E_HTTP_REQUEST_ABORTED } from './Exception.js'
import type { RedirectBuilder } from './RedirectBuilder.js'
import {
  openSseStream,
  type SseStream,
  type SseStreamOptions,
  type StreamBackend,
} from './SseStream.js'

/**
 * Reject CR / LF / NUL bytes in header names or values. Without this guard
 * an attacker controlling part of a header (e.g. a redirect URL parameter
 * echoed into `Location`) could splice extra response headers — the classic
 * CRLF injection / response-splitting attack (CWE-113).
 */
function assertNoCRLF(name: string, value: string): void {
  if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) {
    throw new Error(
      `CRLF / NUL byte in header '${name}' is not allowed (response-splitting protection).`,
    )
  }
}

/**
 * JSON.stringify with AdonisJS-parity safety: `BigInt` values are emitted as
 * strings (native `JSON.stringify` throws on them) and circular references are
 * dropped instead of throwing — so `response.json()` / an object `send()` never
 * blows up on a payload the raw serializer can't handle.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString()
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return undefined
      seen.add(val)
    }
    return val
  })
}

export interface CookieOptions {
  maxAge?: number
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
}

export class Response extends Macroable {
  #status = 200
  #headers: Record<string, string> = {}
  #cookies: string[] = []
  #body = ''
  #finished = false
  #redirectBuilderFactory?: () => RedirectBuilder
  #streamBackend?: StreamBackend
  #streamId?: string
  #request?: { method(): string; header(key: string): string | undefined }
  #cookieSigner?: CookieSigner

  /**
   * CSP nonce for this request (AdonisJS idiom: `response.nonce`). Seeded by
   * the `@c9up/blackhole` middleware when the CSP uses `@nonce`; `undefined`
   * otherwise. Also published to `ctx.store` as `cspNonce` for templating.
   */
  nonce?: string

  // ─── Status ───────────────────────────────────────────────

  /** Set the HTTP status code. Chainable. */
  status(code: number): this {
    this.#status = code
    return this
  }

  /** Set status only if not already set (still 200). */
  safeStatus(code: number): this {
    if (this.#status === 200) {
      this.#status = code
    }
    return this
  }

  // ─── Headers ──────────────────────────────────────────────

  /** Set a response header. Chainable. */
  header(key: string, value: string): this {
    assertNoCRLF(key, value)
    this.#headers[key.toLowerCase()] = value
    return this
  }

  /** Append to a response header (for multi-value like Set-Cookie). */
  append(key: string, value: string): this {
    assertNoCRLF(key, value)
    const k = key.toLowerCase()
    if (k === 'set-cookie') {
      // Set-Cookie must NOT be comma-joined — each cookie is its own
      // header line, or browsers/proxies mis-parse the lot. Route into
      // the same `#cookies` channel `cookie()` uses; `getHeaders()`
      // emits them newline-separated for the serializer.
      this.#cookies.push(value)
      return this
    }
    const existing = this.#headers[k]
    this.#headers[k] = existing ? `${existing}, ${value}` : value
    return this
  }

  /** Remove a response header. */
  removeHeader(key: string): this {
    delete this.#headers[key.toLowerCase()]
    return this
  }

  /**
   * Set a header only if it has not been set yet (AdonisJS `safeHeader`) —
   * the idiom for defaulting a header from middleware without clobbering a
   * value a downstream handler already chose.
   */
  safeHeader(key: string, value: string): this {
    if (!this.getHeader(key)) this.header(key, value)
    return this
  }

  /** Append field(s) to the `Vary` header, de-duplicated (AdonisJS parity). */
  vary(field: string | string[]): this {
    const fields = Array.isArray(field) ? field : [field]
    const current = this.getHeader('vary')
    const existing = current
      ? current
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
      : []
    for (const f of fields) if (!existing.includes(f)) existing.push(f)
    this.header('Vary', existing.join(', '))
    return this
  }

  /** Set the `Location` header without issuing a redirect (AdonisJS parity). */
  location(url: string): this {
    this.header('Location', url)
    return this
  }

  /**
   * Set the Content-Type header. Chainable. AdonisJS parity
   * (`response.type(type, charset?)`): `type` may be a full MIME type OR a file
   * extension — `type('txt')` → `text/plain; charset=utf-8`, `type('json')` →
   * `application/json; charset=utf-8` — resolved via `mime-types` exactly like
   * Adonis. An optional `charset` is appended before resolution.
   */
  type(type: string, charset?: string): this {
    const input = charset ? `${type}; charset=${charset}` : type
    // `contentType()` returns `false` for an unrecognised value — fall back to
    // the raw input rather than writing `content-type: false`.
    const resolved = contentType(input)
    const value = resolved === false ? input : resolved
    // Same CRLF/NUL guard as header() — a resolved type must never be a
    // response-splitting hole just because it writes a fixed header key.
    assertNoCRLF('content-type', value)
    this.#headers['content-type'] = value
    return this
  }

  // ─── Body ─────────────────────────────────────────────────

  /** Send a JSON response. Sets content-type and stringifies. */
  json(data: unknown): void {
    this.#headers['content-type'] = 'application/json'
    this.#body = safeStringify(data)
    this.#finished = true
  }

  /**
   * Send a JSONP response (AdonisJS parity) — wraps the JSON body in a
   * `callbackName(...)` call served as `text/javascript`. The callback name is
   * sanitised to identifier-safe characters and U+2028 / U+2029 are escaped
   * (valid in JSON, but break JS), so neither the callback nor the payload can
   * inject script.
   */
  jsonp(body: unknown, callbackName = 'callback'): void {
    // Sanitise the callback name to identifier-safe characters — the JSONP XSS
    // guard (an attacker-controlled callback must not inject script).
    const safeCallback = callbackName.replace(/[^\w$.]/g, '')
    // Escape U+2028 / U+2029 — valid inside JSON strings but line terminators in
    // JS, so they'd break the wrapped payload in a <script> context (Adonis parity).
    const json = safeStringify(body).replace(/[\u2028\u2029]/g, (c) =>
      c === '\u2028' ? '\\u2028' : '\\u2029',
    )
    this.#headers['content-type'] = 'text/javascript; charset=utf-8'
    this.#body = `/**/ typeof ${safeCallback} === 'function' && ${safeCallback}(${json});`
    this.#finished = true
  }

  /** Send a response body. Auto-detects content type if not set. */
  send(data: unknown): void {
    if (typeof data === 'string') {
      if (!this.#headers['content-type']) {
        // AdonisJS parity: an HTML-looking string (opens with `<`) is served as
        // `text/html`; a plain string as `text/plain` — not everything forced to
        // HTML (which mislabels plain text and JSON/CSV/robots.txt bodies).
        this.#headers['content-type'] = data.trimStart().startsWith('<')
          ? 'text/html; charset=utf-8'
          : 'text/plain; charset=utf-8'
      }
      this.#body = data
    } else if (Buffer.isBuffer(data)) {
      // Without this branch a Buffer would hit the `typeof === 'object'`
      // path and be JSON-stringified into `{"type":"Buffer","data":[...]}`
      // — every binary asset (PNG, PDF, ...) would arrive corrupted.
      this.sendBuffer(data)
      return
    } else if (typeof data === 'object' && data !== null) {
      this.#headers['content-type'] = 'application/json'
      this.#body = safeStringify(data)
    } else if (data !== undefined && data !== null) {
      if (!this.#headers['content-type']) {
        this.#headers['content-type'] = 'text/plain'
      }
      this.#body = String(data)
    }
    this.#finished = true
  }

  /**
   * Send a binary body as-is. Encodes to base64 across the NAPI bridge
   * with the `x-ream-body-encoding: base64` marker so the Rust HTTP
   * layer decodes it before writing to the socket. The marker header is
   * stripped server-side and never leaks to the client.
   *
   * Use this for any non-UTF-8 payload (images, PDFs, archives, etc.) —
   * `send()` auto-routes Buffers here, but call directly when intent is
   * unambiguous.
   */
  sendBuffer(buffer: Buffer): void {
    if (!this.#headers['content-type']) {
      this.#headers['content-type'] = 'application/octet-stream'
    }
    this.#headers['x-ream-body-encoding'] = 'base64'
    this.#body = buffer.toString('base64')
    this.#finished = true
  }

  /** Send 204 No Content. */
  noContent(): void {
    this.#status = 204
    this.#body = ''
    this.#finished = true
  }

  // ─── Descriptive status methods (AdonisJS parity) ────────
  // Each sets the status then sends the (optional) body — mirrors
  // `@adonisjs/http-server` Response (e.g. `response.notFound(body)`).

  /** 100 Continue. */
  continue(): void {
    this.status(100)
  }

  /** 101 Switching Protocols. */
  switchingProtocols(): void {
    this.status(101)
  }

  /** 200 ok. */
  ok(body?: unknown): void {
    this.status(200)
    this.send(body)
  }

  /** 201 created. */
  created(body?: unknown): void {
    this.status(201)
    this.send(body)
  }

  /** 202 accepted. */
  accepted(body?: unknown): void {
    this.status(202)
    this.send(body)
  }

  /** 203 nonAuthoritativeInformation. */
  nonAuthoritativeInformation(body?: unknown): void {
    this.status(203)
    this.send(body)
  }

  /** 205 resetContent. */
  resetContent(body?: unknown): void {
    this.status(205)
    this.send(body)
  }

  /** 206 partialContent. */
  partialContent(body?: unknown): void {
    this.status(206)
    this.send(body)
  }

  /** 300 multipleChoices. */
  multipleChoices(body?: unknown): void {
    this.status(300)
    this.send(body)
  }

  /** 301 movedPermanently. */
  movedPermanently(body?: unknown): void {
    this.status(301)
    this.send(body)
  }

  /** 302 movedTemporarily. */
  movedTemporarily(body?: unknown): void {
    this.status(302)
    this.send(body)
  }

  /** 303 seeOther. */
  seeOther(body?: unknown): void {
    this.status(303)
    this.send(body)
  }

  /** 304 notModified. */
  notModified(body?: unknown): void {
    this.status(304)
    this.send(body)
  }

  /** 305 useProxy. */
  useProxy(body?: unknown): void {
    this.status(305)
    this.send(body)
  }

  /** 307 temporaryRedirect. */
  temporaryRedirect(body?: unknown): void {
    this.status(307)
    this.send(body)
  }

  /** 400 badRequest. */
  badRequest(body?: unknown): void {
    this.status(400)
    this.send(body)
  }

  /** 401 unauthorized. */
  unauthorized(body?: unknown): void {
    this.status(401)
    this.send(body)
  }

  /** 402 paymentRequired. */
  paymentRequired(body?: unknown): void {
    this.status(402)
    this.send(body)
  }

  /** 403 forbidden. */
  forbidden(body?: unknown): void {
    this.status(403)
    this.send(body)
  }

  /** 404 notFound. */
  notFound(body?: unknown): void {
    this.status(404)
    this.send(body)
  }

  /** 405 methodNotAllowed. */
  methodNotAllowed(body?: unknown): void {
    this.status(405)
    this.send(body)
  }

  /** 406 notAcceptable. */
  notAcceptable(body?: unknown): void {
    this.status(406)
    this.send(body)
  }

  /** 407 proxyAuthenticationRequired. */
  proxyAuthenticationRequired(body?: unknown): void {
    this.status(407)
    this.send(body)
  }

  /** 408 requestTimeout. */
  requestTimeout(body?: unknown): void {
    this.status(408)
    this.send(body)
  }

  /** 409 conflict. */
  conflict(body?: unknown): void {
    this.status(409)
    this.send(body)
  }

  /** 410 gone. */
  gone(body?: unknown): void {
    this.status(410)
    this.send(body)
  }

  /** 411 lengthRequired. */
  lengthRequired(body?: unknown): void {
    this.status(411)
    this.send(body)
  }

  /** 412 preconditionFailed. */
  preconditionFailed(body?: unknown): void {
    this.status(412)
    this.send(body)
  }

  /** 413 requestEntityTooLarge. */
  requestEntityTooLarge(body?: unknown): void {
    this.status(413)
    this.send(body)
  }

  /** 414 requestUriTooLong. */
  requestUriTooLong(body?: unknown): void {
    this.status(414)
    this.send(body)
  }

  /** 415 unsupportedMediaType. */
  unsupportedMediaType(body?: unknown): void {
    this.status(415)
    this.send(body)
  }

  /** 416 requestedRangeNotSatisfiable. */
  requestedRangeNotSatisfiable(body?: unknown): void {
    this.status(416)
    this.send(body)
  }

  /** 417 expectationFailed. */
  expectationFailed(body?: unknown): void {
    this.status(417)
    this.send(body)
  }

  /** 422 unprocessableEntity. */
  unprocessableEntity(body?: unknown): void {
    this.status(422)
    this.send(body)
  }

  /** 429 tooManyRequests. */
  tooManyRequests(body?: unknown): void {
    this.status(429)
    this.send(body)
  }

  /** 500 internalServerError. */
  internalServerError(body?: unknown): void {
    this.status(500)
    this.send(body)
  }

  /** 501 notImplemented. */
  notImplemented(body?: unknown): void {
    this.status(501)
    this.send(body)
  }

  /** 502 badGateway. */
  badGateway(body?: unknown): void {
    this.status(502)
    this.send(body)
  }

  /** 503 serviceUnavailable. */
  serviceUnavailable(body?: unknown): void {
    this.status(503)
    this.send(body)
  }

  /** 504 gatewayTimeout. */
  gatewayTimeout(body?: unknown): void {
    this.status(504)
    this.send(body)
  }

  /** 505 httpVersionNotSupported. */
  httpVersionNotSupported(body?: unknown): void {
    this.status(505)
    this.send(body)
  }

  // ─── Redirect ─────────────────────────────────────────────

  /** Get a redirect builder. */
  redirect(): RedirectBuilder {
    if (this.#redirectBuilderFactory) {
      return this.#redirectBuilderFactory()
    }
    throw new Error(
      'redirect() requires an HttpContext. Response was created outside a request handler.',
    )
  }

  /** @internal Set the redirect builder factory (injected by HttpContext). */
  /** Give the response access to the request (wired by HttpContext) — used by `fresh()`. */
  setRequest(request: { method(): string; header(key: string): string | undefined }): void {
    this.#request = request
  }

  /** Inject the APP_KEY-backed cookie signer — wired by HttpContext. */
  setCookieSigner(signer: CookieSigner): void {
    this.#cookieSigner = signer
  }

  /** Set a strong (or weak) `ETag` for the given body (AdonisJS parity, `etag` pkg). */
  setEtag(body: string | Buffer, weak = false): this {
    this.header('Etag', etag(body, { weak }))
    return this
  }

  /**
   * Whether the client's cached copy is still fresh (AdonisJS `fresh`) — a
   * cacheable method (GET/HEAD) with a 2xx/304 status whose `If-None-Match`
   * matches this response's `ETag`. Lets a handler answer `304 Not Modified`.
   */
  fresh(): boolean {
    const method = this.#request?.method()
    if (method && method !== 'GET' && method !== 'HEAD') return false
    const status = this.#status
    if (!((status >= 200 && status < 300) || status === 304)) return false
    const noneMatch = this.#request?.header('if-none-match')
    const currentEtag = this.getHeader('etag')
    if (!noneMatch || !currentEtag) return false
    if (noneMatch.trim() === '*') return true
    return noneMatch.split(',').some((tag) => {
      const t = tag.trim()
      return t === currentEtag || t === `W/${currentEtag}` || `W/${t}` === currentEtag
    })
  }

  /**
   * Abort the request with a body + status (AdonisJS parity) — throws
   * `E_HTTP_REQUEST_ABORTED`, which the exception handler renders (a string body
   * verbatim, anything else as JSON).
   */
  abort(body: unknown, status = 400): never {
    throw new E_HTTP_REQUEST_ABORTED(body, status)
  }

  /** Abort only when `condition` is truthy (AdonisJS `abortIf`). */
  abortIf(
    condition: unknown,
    body: unknown,
    status = 400,
  ): asserts condition is undefined | null | false {
    if (condition) this.abort(body, status)
  }

  /**
   * Send a file to the client (AdonisJS `download`) — reads the file, infers the
   * content-type from its extension, and sends it as a binary body. On a read
   * error, `errorCallback` may map it to `[message, status?]`, else a 404.
   */
  download(
    filePath: string,
    generateEtag = false,
    errorCallback?: (error: NodeJS.ErrnoException) => [string, number?],
  ): void {
    let content: Buffer
    try {
      content = readFileSync(filePath)
    } catch (error) {
      if (errorCallback) {
        const [message, status] = errorCallback(error as NodeJS.ErrnoException)
        this.status(status ?? 404).send(message)
        return
      }
      this.status(404).send('Not Found')
      return
    }
    const ct = contentType(basename(filePath))
    if (ct) this.#headers['content-type'] = ct
    if (generateEtag) this.setEtag(content)
    this.sendBuffer(content)
  }

  /**
   * Force a file download with a `Content-Disposition` header (AdonisJS
   * `attachment`). Defaults the filename to the file's basename.
   */
  attachment(
    filePath: string,
    name?: string,
    disposition = 'attachment',
    generateEtag = false,
  ): void {
    const filename = name ?? basename(filePath)
    this.header('Content-Disposition', `${disposition}; filename="${filename}"`)
    this.download(filePath, generateEtag)
  }

  setRedirectFactory(factory: () => RedirectBuilder): void {
    this.#redirectBuilderFactory = factory
  }

  /** @internal Wire the SSE backend (HyperServer NAPI). Injected by HttpKernel. */
  setStreamBackend(backend: StreamBackend): void {
    this.#streamBackend = backend
  }

  // ─── Streaming (SSE) ──────────────────────────────────────

  /**
   * Open a Server-Sent Events stream. The returned `SseStream` lets the
   * handler push named events for as long as the client stays
   * connected. Headers are pre-set to the SSE wire format; the host
   * router serializes the response with the reserved stream id so the
   * Rust HyperServer keeps the connection open.
   *
   *   const sse = await ctx.response.sse()
   *   sse.send('connected', { uid: caller.id })
   *   onTaskAssigned((evt) => sse.send('task.assigned', evt))
   *
   * Throws `STREAMING_UNSUPPORTED` if the underlying HyperServer host
   * does not implement the streaming NAPI (e.g. a mock server in unit
   * tests). The host capability is opt-in: implement
   * `registerStream`/`writeStream`/`closeStream`/`onStreamDisconnect`
   * to participate.
   */
  async sse(options?: SseStreamOptions): Promise<SseStream> {
    if (!this.#streamBackend) {
      throw new Error(
        '[ream] response.sse() requires a streaming-capable HyperServer host. ' +
          'The current server has no stream backend wired.',
      )
    }
    // SSE wire format + safety defaults. The buffered body string stays
    // empty — every chunk goes through the registry instead.
    this.#headers['content-type'] = 'text/event-stream'
    if (!this.#headers['cache-control']) {
      this.#headers['cache-control'] = 'no-cache, no-transform'
    }
    if (!this.#headers['x-accel-buffering']) {
      this.#headers['x-accel-buffering'] = 'no'
    }
    const stream = await openSseStream(this.#streamBackend, options)
    this.#streamId = stream.id
    // Mark the response as "finished" so middleware that bails when
    // `isFinished()` is true (the standard short-circuit) doesn't
    // re-touch the body or headers after the SSE pipe has been set up.
    this.#finished = true
    return stream
  }

  // ─── Cookies ──────────────────────────────────────────────

  /**
   * Set a SIGNED response cookie (AdonisJS default). The value is HMAC-signed
   * with the app's `APP_KEY` (via the injected signer) so tampering is detected
   * on read; `request.cookie()` verifies + unwraps it. Falls back to a plain
   * cookie when no APP_KEY / encryption service is configured.
   */
  cookie(name: string, value: string, options?: CookieOptions): this {
    const signed = this.#cookieSigner ? this.#cookieSigner.sign(value) : value
    return this.#writeCookie(name, signed, options)
  }

  /**
   * Set an UNSIGNED response cookie (AdonisJS `plainCookie`) — sent as-is. Use
   * for values you already protect (encrypted session ids, CSRF tokens) or that
   * a client-side script must read.
   */
  plainCookie(name: string, value: string, options?: CookieOptions): this {
    return this.#writeCookie(name, value, options)
  }

  /**
   * Set an ENCRYPTED response cookie (AdonisJS `encryptedCookie`) — AES-256-GCM
   * encrypted with `APP_KEY`, unreadable + tamper-proof on the client. Requires
   * a configured encryption service (APP_KEY).
   */
  encryptedCookie(name: string, value: string, options?: CookieOptions): this {
    if (!this.#cookieSigner) {
      throw new Error(
        'encryptedCookie() requires APP_KEY — set it so the encryption service is registered.',
      )
    }
    return this.#writeCookie(name, this.#cookieSigner.encrypt(value), options)
  }

  #writeCookie(name: string, value: string, options?: CookieOptions): this {
    // SameSite=None cookies REQUIRE the Secure attribute — modern browsers
    // (Chrome 80+, Firefox, Safari) silently reject the cookie otherwise, so
    // a missing Secure here turns OAuth callbacks / iframe sessions into a
    // "works in dev (localhost relaxes Secure), breaks in prod" foot-gun.
    if (options?.sameSite === 'none' && !options.secure) {
      throw new Error(
        `Cookie '${name}': SameSite=None requires Secure: true (browsers reject SameSite=None cookies without Secure).`,
      )
    }
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`]
    // `maxAge: 0` is the RFC 6265 "delete-now" signal used by logout flows. A
    // truthiness check would skip it; explicit `!== undefined` covers 0 too.
    if (options?.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
    if (options?.path) {
      // `Path` is concatenated raw (encodeURIComponent would mangle `/`), so it
      // needs the same CRLF/NUL guard as header() (response-splitting).
      assertNoCRLF(`Set-Cookie path for '${name}'`, options.path)
      parts.push(`Path=${options.path}`)
    }
    if (options?.httpOnly !== false) parts.push('HttpOnly')
    if (options?.secure) parts.push('Secure')
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`)
    this.#cookies.push(parts.join('; '))
    return this
  }

  /**
   * Expire a cookie immediately (AdonisJS `clearCookie`) — re-sends it with
   * `Max-Age=0`, the RFC 6265 delete-now signal that `cookie()` honours.
   */
  clearCookie(name: string, options?: { path?: string }): this {
    return this.plainCookie(name, '', { ...options, maxAge: 0 })
  }

  // ─── Internals (used by HttpKernel for NAPI serialization) ─

  /** @internal Get the accumulated status code. */
  getStatus(): number {
    return this.#status
  }

  /** @internal Get all accumulated headers (Set-Cookie as separate entries joined by newline). */
  getHeaders(): Record<string, string> {
    const headers = { ...this.#headers }
    if (this.#cookies.length > 0) {
      // Multiple Set-Cookie headers must be separate — we join with \n for the serializer
      headers['set-cookie'] = this.#cookies.join('\n')
    }
    return headers
  }

  /**
   * Read a single accumulated response header by name (case-insensitive).
   * Returns `undefined` when not set — used by middleware that conditionally
   * inspects the outgoing content-type before sanitisation.
   */
  getHeader(name: string): string | undefined {
    return this.#headers[name.toLowerCase()]
  }

  /** @internal Get the accumulated body string. */
  getBody(): string {
    return this.#body
  }

  /** @internal Check if response has been finalized. */
  isFinished(): boolean {
    return this.#finished
  }

  /** @internal Set body directly (used by redirect, exception handler). */
  setBody(body: string): void {
    this.#body = body
    this.#finished = true
  }

  /**
   * @internal Streaming-response handle, set by `sse()`. The host
   * router forwards this id to the Rust HyperServer so the connection
   * stays open and chunks flow from the JS-side writer.
   */
  getStreamId(): string | undefined {
    return this.#streamId
  }

  /**
   * @internal Tear down a stream the handler opened via `sse()` but
   * then abandoned by throwing. Closes the backend registry slot and
   * clears the stream id + finished flag so the kernel's error path
   * serializes a normal buffered error response instead of emitting
   * `streamId` alongside an error body (which would leave the
   * HyperServer feeding a dead/empty stream forever). Best-effort: a
   * closeStream failure is swallowed — the slot's TTL/disconnect will
   * reclaim it.
   */
  async abortStream(): Promise<void> {
    const id = this.#streamId
    if (id === undefined) return
    this.#streamId = undefined
    this.#finished = false
    if (this.#streamBackend) {
      try {
        await this.#streamBackend.closeStream(id)
      } catch {
        // benign — registry TTL / client disconnect reclaims the slot.
      }
    }
  }
}

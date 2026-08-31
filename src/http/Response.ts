/**
 * Response — accumulates HTTP response state with a fluent API.
 *
 * Wraps the same { status, headers, body } wire format expected by the NAPI layer.
 * Provides AdonisJS-compatible methods: json(), send(), status(), header(), etc.
 *
 * @implements FR21
 */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import etag from 'etag'
import { contentType } from 'mime-types'
import { ReamError } from '../errors/ReamError.js'
import { durationToSeconds } from '../helpers/duration.js'

/**
 * Default ceiling on a buffered response body — the same 100MB the Rust layer
 * caps an incoming body at (`MAX_BODY_BYTES` in crates/ream-http/src/server.rs).
 */
const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024

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
 * Build a `Content-Disposition` value for a download (RFC 6266).
 *
 * The filename sits in a quoted-string, so a `"` inside it would close the
 * field early and the rest would be read as further parameters. Backslash and
 * quote are escaped, which is what a quoted-string allows.
 *
 * A non-ASCII name cannot go in that field at all — the header is Latin-1 — so
 * it also gets `filename*=UTF-8''…`, and the plain `filename=` keeps an ASCII
 * approximation for clients that ignore the extended form. Without it an
 * accented name reached the browser as mojibake, or was dropped.
 */
function contentDisposition(disposition: string, filename: string): string {
  const quoted = filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const ascii = quoted.replace(/[^\x20-\x7e]/g, '_')
  const base = `${disposition}; filename="${ascii}"`
  if (ascii === quoted) return base
  return `${base}; filename*=UTF-8''${encodeURIComponent(filename)}`
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

/**
 * Pack a cookie value the way AdonisJS does: a JSON envelope, base64url.
 *
 * The envelope is what carries the TYPE — without it every cookie comes back a
 * string, and `plainCookie('count', 3)` would read as `"3"` next request.
 */
function packCookieValue(value: unknown): string {
  return Buffer.from(JSON.stringify({ message: value }), 'utf8').toString('base64url')
}

/**
 * Unpack a value written by {@link packCookieValue}.
 *
 * Anything that is not one of our envelopes comes back untouched — a cookie set
 * by something else, or written with `encode: false`, is still readable.
 */
export function unpackCookieValue(raw: string): unknown {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      return (parsed as { message: unknown }).message
    }
    return raw
  } catch {
    return raw
  }
}

export interface CookieOptions {
  /**
   * Cookie lifetime. A NUMBER is seconds; a STRING is parsed the way Adonis
   * parses it (`'2 hours'`, `'30 mins'`, `'7 days'`, `'2h'`…), including its
   * rule that a unitless string is milliseconds — see `helpers/duration.ts`.
   */
  maxAge?: number | string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  /**
   * `false` omits the attribute entirely (AdonisJS accepts the boolean form);
   * `true` is not a valid attribute value and is rejected.
   */
  sameSite?: boolean | 'lax' | 'strict' | 'none'
  /** Domain the cookie is valid for — what makes it readable across subdomains. */
  domain?: string
  /** Absolute expiry, or a function returning one (AdonisJS `expires`). */
  expires?: Date | (() => Date)
  /** CHIPS partitioned cookie: keyed to the top-level site as well as the domain. */
  partitioned?: boolean
  /** Eviction priority hint (Chromium). */
  priority?: 'low' | 'medium' | 'high'
}

export class Response extends Macroable {
  #status = 200
  /** A body still being drained by {@link stream}; awaited by {@link finish}. */
  #pendingStream: Promise<void> | undefined
  /** The detached chunk pump, when one is running. See {@link streamed}. */
  #pumping: Promise<void> | undefined
  /** Whether {@link finish} has run — its idempotence guard. */
  #finalised = false
  #headers: Record<string, string> = {}
  #cookies: string[] = []
  #body = ''
  readonly #finishCallbacks: Array<(err: Error | null) => void> = []
  #finished = false
  /**
   * The context this response belongs to (AdonisJS `response.ctx`).
   *
   * Wired by HttpContext. Optional because a Response built by hand — a test,
   * a fixture — has no context around it.
   */
  ctx?: object

  /** Default JSONP callback name (AdonisJS `http.jsonpCallbackName`). */
  #jsonpCallbackName = 'callback'
  /**
   * Ceiling on a buffered response body. Mirrors the 100MB the Rust layer caps
   * an incoming body at, so the two directions are explained the same way.
   */
  #maxBodyBytes = DEFAULT_MAX_RESPONSE_BYTES
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
    this.#setBody(safeStringify(data))
    this.#finished = true
  }

  /**
   * Send a JSONP response (AdonisJS parity) — wraps the JSON body in a
   * `callbackName(...)` call served as `text/javascript`. The callback name is
   * sanitised to identifier-safe characters and U+2028 / U+2029 are escaped
   * (valid in JSON, but break JS), so neither the callback nor the payload can
   * inject script.
   */
  /**
   * Default callback name when `jsonp()` is called without one (AdonisJS reads
   * it from `http.jsonpCallbackName`). Injected by HttpKernel, the same way the
   * cookie signer and signed-URL services are.
   */
  setJsonpCallbackName(name: string): void {
    this.#jsonpCallbackName = name
  }

  jsonp(body: unknown, callbackName: string = this.#jsonpCallbackName): void {
    // Sanitise the callback name to identifier-safe characters — the JSONP XSS
    // guard (an attacker-controlled callback must not inject script).
    const safeCallback = callbackName.replace(/[^\w$.]/g, '')
    // Escape U+2028 / U+2029 — valid inside JSON strings but line terminators in
    // JS, so they'd break the wrapped payload in a <script> context (Adonis parity).
    const json = safeStringify(body).replace(/[\u2028\u2029]/g, (c) =>
      c === '\u2028' ? '\\u2028' : '\\u2029',
    )
    this.#headers['content-type'] = 'text/javascript; charset=utf-8'
    this.#setBody(`/**/ typeof ${safeCallback} === 'function' && ${safeCallback}(${json});`)
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
      this.#setBody(data)
    } else if (Buffer.isBuffer(data)) {
      // Without this branch a Buffer would hit the `typeof === 'object'`
      // path and be JSON-stringified into `{"type":"Buffer","data":[...]}`
      // — every binary asset (PNG, PDF, ...) would arrive corrupted.
      this.sendBuffer(data)
      return
    } else if (typeof data === 'object' && data !== null) {
      this.#headers['content-type'] = 'application/json'
      this.#setBody(safeStringify(data))
    } else if (data !== undefined && data !== null) {
      if (!this.#headers['content-type']) {
        this.#headers['content-type'] = 'text/plain'
      }
      this.#setBody(String(data))
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
    this.#assertBodyFits(buffer.length)
    if (!this.#headers['content-type']) {
      this.#headers['content-type'] = 'application/octet-stream'
    }
    this.#headers['x-ream-body-encoding'] = 'base64'
    this.#body = buffer.toString('base64')
    this.#finished = true
  }

  /**
   * Refuse a body too large to hold in memory.
   *
   * A response body is serialised whole across the NAPI boundary — there is no
   * chunked write yet — and a binary one is base64'd on the way, so it costs
   * roughly 2.3x its size in transient memory: the Buffer, the encoded string,
   * and the Rust-side decode. Without a ceiling a large file did not fail, it
   * grew until the process died, with no message naming the cause.
   *
   * Raise it with `maxResponseBytes` in the kernel config when you know the
   * memory is there. For anything genuinely large, hand out a signed URL from
   * `@c9up/archive` instead and let the client fetch it from storage — the
   * bytes then never pass through the server at all.
   */
  /**
   * Assign the body, refusing one too large to hold.
   *
   * Every textual path goes through here — `json()`, `send()`, `jsonp()`, a
   * middleware rewriting the body. The ceiling used to live only in
   * `sendBuffer()`, so `json(hugeObject)` and `send(hugeString)` walked past
   * it and the process grew until it died, which is the failure the ceiling
   * exists to name.
   *
   * Measured in UTF-8 BYTES, not characters: a string of accented or CJK text
   * is one and a half to three times its length on the wire.
   */
  #setBody(body: string): void {
    this.#assertBodyFits(Buffer.byteLength(body, 'utf8'))
    this.#body = body
  }

  #assertBodyFits(bytes: number): void {
    if (bytes <= this.#maxBodyBytes) return
    throw new ReamError(
      'E_RESPONSE_TOO_LARGE',
      `Response body is ${Math.round(bytes / 1_048_576)}MB, over the ${Math.round(this.#maxBodyBytes / 1_048_576)}MB ceiling.`,
      {
        context: {
          bytes: String(bytes),
          ceiling: String(this.#maxBodyBytes),
        },
        hint:
          'The body is held whole in memory (and base64-encoded, ~2.3x) because responses are not streamed yet. ' +
          'Raise `maxResponseBytes` in the kernel config, or serve large files with a signed URL from @c9up/archive.',
      },
    )
  }

  /** @internal Set the ceiling — injected by HttpKernel from its config. */
  setMaxBodyBytes(bytes: number): void {
    this.#maxBodyBytes = bytes
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

  /**
   * Redirect, or get the builder.
   *
   * `redirect()` with no argument hands back the builder to chain on. With a
   * PATH it redirects immediately, as AdonisJS does
   * (`redirect(path, forwardQueryString?, statusCode?)`); `'back'` goes to the
   * referrer. Ream always returned the builder, so `response.redirect('/login')`
   * — the shortest and most obvious spelling — silently did nothing.
   */
  redirect(): RedirectBuilder
  redirect(path: string, forwardQueryString?: boolean, statusCode?: number): void
  redirect(
    path?: string,
    forwardQueryString = false,
    statusCode = 302,
  ): RedirectBuilder | undefined {
    if (!this.#redirectBuilderFactory) {
      throw new Error(
        'redirect() requires an HttpContext. Response was created outside a request handler.',
      )
    }
    const builder = this.#redirectBuilderFactory()
    if (path === undefined) return builder
    if (forwardQueryString) builder.withQs()
    if (path === 'back') {
      builder.status(statusCode).back()
      return
    }
    builder.status(statusCode).toPath(path)
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

  /**
   * Abort unless `condition` is truthy (AdonisJS `abortUnless`) — the guard
   * clause form: `response.abortUnless(user, 'Not found', 404)` narrows `user`
   * for everything after it.
   */
  abortUnless<T>(
    condition: T,
    body: unknown,
    status = 400,
  ): asserts condition is Exclude<T, undefined | null | false> {
    if (!condition) this.abort(body, status)
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
   * @internal Wait for a body still being produced (see {@link stream}). The
   * kernel calls this before serializing; everything else resolves at once.
   */
  /**
   * Resolves when a streamed body has finished feeding the socket.
   *
   * Deliberately NOT part of {@link finish}: the response has to reach Rust
   * with its stream id before the body can be attached, so waiting for the
   * pump there would deadlock — and closing the stream first is what made the
   * client see `E_STREAM_UNKNOWN` instead of the file. This is for a test that
   * wants the finished body, and for a shutdown that would rather let an
   * in-flight download end than cut it.
   */
  streamed(): Promise<void> {
    return this.#pumping ?? Promise.resolve()
  }

  /**
   * Finalise the response — the terminal step (AdonisJS `response.finish()`).
   *
   * Same role and same guarantees as upstream: idempotent, it stamps the
   * request id, and afterwards nothing more is added to the response. The
   * kernel calls it before reading the response out; an app rarely needs to.
   *
   * NAMED DEVIATION — it returns a promise where upstream returns void, and it
   * writes nothing. Ream never owns the socket: the whole response crosses the
   * NAPI boundary and Rust writes it, so "finish" here means *sealed and ready
   * to hand over* rather than *flushed*. The await is for a body still being
   * produced — `download()` and a buffered `stream()` fill it asynchronously.
   *
   * A STREAMED body is deliberately not awaited: it feeds the socket after the
   * response has been handed over. See {@link streamed}.
   */
  async finish(): Promise<void> {
    if (this.#finalised) return
    this.#finalised = true
    this.setRequestId()
    const pending = this.#pendingStream
    if (pending === undefined) return
    this.#pendingStream = undefined
    await pending
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
    // Read asynchronously, parked on the same pending-body slot `stream()`
    // uses and `finish()` already awaits before serialisation. It used to be
    // `readFileSync`, which stalled the event loop for EVERY concurrent
    // request while one client downloaded — the file's size became every
    // other request's latency.
    this.#pendingStream = this.#readForDownload(filePath, generateEtag, errorCallback)
  }

  async #readForDownload(
    filePath: string,
    generateEtag: boolean,
    errorCallback?: (error: NodeJS.ErrnoException) => [string, number?],
  ): Promise<void> {
    // Stat first: a missing or unreadable file must answer 404 BEFORE any
    // header goes out, and once a stream starts there is no status left to
    // change.
    let size: number
    try {
      size = (await stat(filePath)).size
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

    // An ETag is a hash of the whole file, so asking for one asks for the file
    // in memory. Without one, stream it: the body goes out as it is read and
    // nothing bigger than a chunk is ever held.
    if (!generateEtag && this.#streamBackend?.writeStreamBytes !== undefined) {
      this.#headers['content-length'] = String(size)
      await this.#pipe(createReadStream(filePath), errorCallback)
      return
    }

    const content = await readFile(filePath)
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
    this.header('Content-Disposition', contentDisposition(disposition, filename))
    this.download(filePath, generateEtag)
  }

  /**
   * Run `callback` once the response has been sent (AdonisJS `onFinish`).
   *
   * Where a temp file gets deleted, a timer stopped, a metric recorded — work
   * that must not delay the reply but must still happen. Callbacks run after
   * the body is handed to the server; one that throws is reported and does not
   * stop the others, since by then the client already has its answer.
   *
   * NAMED DEVIATION: AdonisJS hands the Node `ServerResponse` to the callback.
   * Ream's response crosses a NAPI boundary and there is no such object, so the
   * callback receives only the error slot.
   */
  onFinish(callback: (err: Error | null) => void): void {
    this.#finishCallbacks.push(callback)
  }

  /** @internal Drain the finish callbacks. Called by HttpKernel once sent. */
  runFinishCallbacks(err: Error | null = null): void {
    const callbacks = this.#finishCallbacks.splice(0)
    for (const callback of callbacks) {
      try {
        callback(err)
      } catch {
        // The client already has its answer; one failing hook must not take
        // the others with it.
      }
    }
  }

  /**
   * Send a readable stream as the response body (AdonisJS `stream`).
   *
   * NAMED DEVIATION: the stream is CONSUMED into the body rather than piped.
   * Ream hands a complete response across the NAPI boundary, so there is no
   * socket to pipe into — the same reason `download()` reads a file rather
   * than streaming it. For a large payload, prefer `sse()`, which does stream.
   *
   * `errorCallback` maps a read failure to `[message, status]`, as upstream;
   * without one, a failure answers 500 with a generic message rather than
   * leaking the filesystem error to the client.
   *
   * Upstream's `stream()` returns void and a controller never awaits it, so a
   * migrated controller does not either. The drain is therefore REGISTERED as
   * well as returned: the kernel awaits it before serializing, and a caller
   * that ignores the promise still sends the whole body instead of an empty
   * one. Awaiting it keeps working.
   */
  stream(
    body: NodeJS.ReadableStream,
    errorCallback?: (error: NodeJS.ErrnoException) => [string, number?],
  ): Promise<void> {
    const draining = this.#pipe(body, errorCallback)
    this.#pendingStream = draining
    return draining
  }

  /**
   * Send a readable as the body.
   *
   * Chunks go to the socket as they arrive when the host can carry them —
   * nothing bigger than one chunk is ever held, so the file's size stops being
   * the process's memory ceiling. A host with no binary stream backend (a unit
   * test, a mock server) falls back to draining into memory, which is what
   * this always used to do.
   */
  async #pipe(
    body: NodeJS.ReadableStream,
    errorCallback?: (error: NodeJS.ErrnoException) => [string, number?],
  ): Promise<void> {
    const backend = this.#streamBackend
    const writeBytes = backend?.writeStreamBytes
    if (backend === undefined || writeBytes === undefined) {
      return this.#drain(body, errorCallback)
    }

    const streamId = randomUUID()
    if (!(await backend.registerStream(streamId))) {
      // The id collided — vanishingly unlikely, but answering with a body
      // nobody feeds would hang the client forever.
      return this.#drain(body, errorCallback)
    }
    if (!this.#headers['content-type']) {
      this.#headers['content-type'] = 'application/octet-stream'
    }
    this.#streamId = streamId
    this.#finished = true

    // Pump DETACHED, exactly as `sse()` does. What is awaited here is only the
    // registration: the kernel awaits this before handing the response back to
    // Rust, and Rust then looks the id up to attach the body. Awaiting the pump
    // instead would close the stream before that lookup ever happened, and the
    // client would get `E_STREAM_UNKNOWN` in place of the file.
    this.#pumping = this.#pump(backend, writeBytes.bind(backend), streamId, body, errorCallback)
  }

  /** Feed a registered stream until the source ends or the client leaves. */
  async #pump(
    backend: StreamBackend,
    writeBytes: (id: string, chunk: Uint8Array) => Promise<boolean>,
    streamId: string,
    body: NodeJS.ReadableStream,
    errorCallback?: (error: NodeJS.ErrnoException) => [string, number?],
  ): Promise<void> {
    try {
      for await (const chunk of body) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        // `false` means the client is gone. Stop reading the source rather
        // than pumping a whole file into a closed socket.
        if (!(await writeBytes(streamId, bytes))) break
      }
    } catch (err) {
      // The headers are already out, so there is no status left to change: end
      // the body and let the client see a short read. `errorCallback` is still
      // consulted for whatever logging it does.
      errorCallback?.(err as NodeJS.ErrnoException)
    } finally {
      // Never rethrows: this runs detached, and an unhandled rejection here
      // would take the process down over one client's download.
      await backend.closeStream(streamId).catch(() => {})
    }
  }

  /** Read the whole body into memory. The fallback when nothing can stream. */
  async #drain(
    body: NodeJS.ReadableStream,
    errorCallback?: (error: NodeJS.ErrnoException) => [string, number?],
  ): Promise<void> {
    const chunks: Buffer[] = []
    try {
      for await (const chunk of body) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      }
    } catch (err) {
      const [message, status] = errorCallback
        ? errorCallback(err as NodeJS.ErrnoException)
        : ['Cannot process the request', 500]
      this.status(status ?? 500)
      this.send(message)
      return
    }
    this.sendBuffer(Buffer.concat(chunks))
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
   * Set a SIGNED response cookie (the default). The value is HMAC-signed with
   * the app's `APP_KEY`, so tampering is detected on read; `request.cookie()`
   * verifies and unwraps it.
   *
   * Requires APP_KEY, and REFUSES rather than falling back to a plain cookie.
   * A silent fallback is the worst of both: the caller asked for integrity,
   * the value ships without it, and `request.cookie()` on the far side hands
   * back whatever the client wrote as though it had been verified.
   *
   * The cookie's NAME is signed along with its value, so a signed cookie
   * cannot be lifted onto another name and still verify.
   */
  cookie(name: string, value: string, options?: CookieOptions): this {
    if (!this.#cookieSigner) {
      throw new Error(
        'cookie() signs the value and needs APP_KEY — set it so the encryption service is registered, or use plainCookie() when the value does not need signing.',
      )
    }
    return this.#writeCookie(name, this.#cookieSigner.sign(value, undefined, name), options)
  }

  /**
   * Set an UNSIGNED response cookie (AdonisJS `plainCookie`) — sent as-is. Use
   * for values you already protect (encrypted session ids, CSRF tokens) or that
   * a client-side script must read.
   */
  plainCookie(name: string, value: unknown, options?: CookieOptions & { encode?: boolean }): this {
    // AdonisJS packs the value into a base64url JSON envelope, which is what
    // lets `plainCookie('prefs', { theme: 'dark' })` round-trip as an object.
    // `encode: false` writes the string as-is — for a value a browser script
    // has to read, or one that is already protected (a signed CSRF token).
    const encoded = options?.encode === false ? String(value) : packCookieValue(value)
    return this.#writeCookie(name, encoded, options)
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
    if (options?.sameSite === true) {
      throw new Error(
        `Cookie '${name}': sameSite: true is not an attribute value — use 'lax', 'strict', 'none', or false to omit it.`,
      )
    }
    if (options?.sameSite === 'none' && !options.secure) {
      throw new Error(
        `Cookie '${name}': SameSite=None requires Secure: true (browsers reject SameSite=None cookies without Secure).`,
      )
    }
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`]
    // `maxAge: 0` is the RFC 6265 "delete-now" signal used by logout flows. A
    // truthiness check would skip it; explicit `!== undefined` covers 0 too.
    if (options?.maxAge !== undefined) {
      parts.push(`Max-Age=${durationToSeconds(options.maxAge, 'a cookie maxAge')}`)
    }
    if (options?.path) {
      // `Path` is concatenated raw (encodeURIComponent would mangle `/`), so it
      // needs the same CRLF/NUL guard as header() (response-splitting).
      assertNoCRLF(`Set-Cookie path for '${name}'`, options.path)
      parts.push(`Path=${options.path}`)
    }
    if (options?.domain) {
      // Concatenated raw like `Path`, so it carries the same splitting guard.
      assertNoCRLF(`Set-Cookie domain for '${name}'`, options.domain)
      parts.push(`Domain=${options.domain}`)
    }
    if (options?.expires !== undefined) {
      const at = typeof options.expires === 'function' ? options.expires() : options.expires
      if (Number.isNaN(at.getTime())) {
        throw new Error(`Cookie '${name}': expires is an invalid Date.`)
      }
      parts.push(`Expires=${at.toUTCString()}`)
    }
    if (options?.httpOnly !== false) parts.push('HttpOnly')
    if (options?.secure) parts.push('Secure')
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`)
    // Partitioned only means anything on a Secure cookie, and browsers drop it
    // otherwise — say so rather than emit an attribute that will be ignored.
    if (options?.partitioned) {
      if (!options.secure) {
        throw new Error(
          `Cookie '${name}': partitioned requires Secure: true (browsers ignore partitioned cookies without it).`,
        )
      }
      parts.push('Partitioned')
    }
    if (options?.priority) parts.push(`Priority=${options.priority}`)
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

  // ─── State (AdonisJS getters) ──────────────────────────────
  //
  // Same questions AdonisJS answers on its response, under the same names. Ours
  // only had `isFinished()`, so a migrated `if (response.finished)` read
  // `undefined` and took the wrong branch without a word.

  /** Whether the response has been written out. */
  get finished(): boolean {
    return this.#finished
  }

  /** Whether a body has been set. */
  get hasContent(): boolean {
    return this.#body.length > 0
  }

  /** Whether the body is a stream still being drained. */
  get hasStream(): boolean {
    return this.#pendingStream !== undefined
  }

  /** Whether a body of any kind is waiting to go out. */
  get hasLazyBody(): boolean {
    return this.hasContent || this.hasStream
  }

  /**
   * Whether the headers have gone out.
   *
   * Ream serialises the whole response across the NAPI boundary in one step,
   * so headers and body leave together: this is true exactly when the response
   * is finished, rather than tracking a separate Node `headersSent`.
   */
  get headersSent(): boolean {
    return this.#finished
  }

  /** Whether nothing has been sent yet — the window a middleware can still write in. */
  get isPending(): boolean {
    return !this.headersSent && !this.finished
  }

  /**
   * Echo the caller's `x-request-id` back on the response (AdonisJS
   * `setRequestId`).
   *
   * Ream already READS that header into `ctx.id` — validating its shape and
   * generating one when it is missing — but never sent it back, so a caller
   * could not tie a response to the request id it issued. Nothing is echoed
   * when the client sent none: inventing one here would hand back an id the
   * caller never used.
   */
  setRequestId(): this {
    const incoming = this.#request?.header('x-request-id')
    if (incoming) this.header('x-request-id', incoming)
    return this
  }

  /** @internal Set body directly (used by redirect, exception handler). */
  setBody(body: string): void {
    this.#setBody(body)
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

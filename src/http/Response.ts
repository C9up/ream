/**
 * Response — accumulates HTTP response state with a fluent API.
 *
 * Wraps the same { status, headers, body } wire format expected by the NAPI layer.
 * Provides AdonisJS-compatible methods: json(), send(), status(), header(), etc.
 *
 * @implements FR21
 */

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

export class Response {
  #status = 200
  #headers: Record<string, string> = {}
  #cookies: string[] = []
  #body = ''
  #finished = false
  #redirectBuilderFactory?: () => RedirectBuilder
  #streamBackend?: StreamBackend
  #streamId?: string

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

  /** Set the Content-Type header. Chainable. */
  type(contentType: string): this {
    // Same CRLF/NUL guard as header() — `type(userValue)` must not be a
    // response-splitting hole just because it writes a fixed header key.
    assertNoCRLF('content-type', contentType)
    this.#headers['content-type'] = contentType
    return this
  }

  // ─── Body ─────────────────────────────────────────────────

  /** Send a JSON response. Sets content-type and stringifies. */
  json(data: unknown): void {
    this.#headers['content-type'] = 'application/json'
    this.#body = JSON.stringify(data)
    this.#finished = true
  }

  /** Send a response body. Auto-detects content type if not set. */
  send(data: unknown): void {
    if (typeof data === 'string') {
      if (!this.#headers['content-type']) {
        this.#headers['content-type'] = 'text/html; charset=utf-8'
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
      this.#body = JSON.stringify(data)
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

  /** Set a response cookie. */
  cookie(
    name: string,
    value: string,
    options?: {
      maxAge?: number
      path?: string
      httpOnly?: boolean
      secure?: boolean
      sameSite?: 'lax' | 'strict' | 'none'
    },
  ): this {
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
    // `maxAge: 0` is the RFC 6265 "delete-now" signal used by logout
    // flows. A truthiness check would skip it and leave the cookie
    // alive for the session — explicit `!== undefined` covers both
    // 0 and negative values that browsers also treat as immediate
    // expiry.
    if (options?.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
    if (options?.path) {
      // `Path` is concatenated raw (encodeURIComponent would mangle the `/`
      // separators a path legitimately contains), so it needs the same
      // CRLF/NUL guard as header()/append() — otherwise a controlled path
      // injects into the `\n`-joined Set-Cookie header (response-splitting).
      assertNoCRLF(`Set-Cookie path for '${name}'`, options.path)
      parts.push(`Path=${options.path}`)
    }
    if (options?.httpOnly !== false) parts.push('HttpOnly')
    if (options?.secure) parts.push('Secure')
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`)
    this.#cookies.push(parts.join('; '))
    return this
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

/**
 * TestClient — supertest-like HTTP client for integration testing.
 *
 * Boots a Ream application on an ephemeral port and provides a fluent API
 * for sending requests and asserting responses.
 *
 * Usage:
 *   const client = new TestClient(createApp)
 *   await client.boot()
 *   const res = await client.get('/api/health')
 *   expect(res.status).toBe(200)
 *   await client.close()
 *
 * Or with the helper:
 *   const client = await createTestClient(createApp)
 *   const res = await client.post('/api/users').json({ name: 'Alice' }).send()
 *   await client.close()
 */

import type { Plugin } from '@c9up/helix'
import type { Dict } from '../types/helpers.js'
import {
  type AuthStrategy,
  type HttpMethod,
  type HttpSender,
  RequestBuilder,
} from './RequestBuilder.js'

export interface TestResponse {
  status: number
  headers: Dict
  body: string
  json<T = unknown>(): T
}

/**
 * Fluent request builder. Thenable like AdonisJS/japa's api-client: `await
 * client.get('/x')` sends the request, and chaining works on every verb —
 * `await client.get('/x').header('authorization', token)`. The explicit
 * `.send()` is kept for callers that prefer it.
 */
export interface TestRequestBuilder extends PromiseLike<TestResponse> {
  /** Set a request header. */
  header(name: string, value: string): TestRequestBuilder
  /** Set the request body as JSON. */
  json(data: unknown): TestRequestBuilder
  /** Set a raw string body with optional content type. */
  body(content: string, contentType?: string): TestRequestBuilder
  /** Set a cookie. */
  cookie(name: string, value: string): TestRequestBuilder
  /** Send the request and return the response. */
  send(): Promise<TestResponse>
}

/**
 * Named-route manifest — `name → path pattern`, e.g. `{ 'users.show':
 * '/users/:id' }`. Feed `router.namedManifest()` here so `visit()` can resolve
 * named routes without the full Router.
 */
export type RouteManifest = Record<string, string>

export class TestClient {
  #port = 0
  #headers: Dict = {}
  #bootFn: (port: number) => Promise<{ port: number; close: () => Promise<void> | void }>
  #auth: AuthStrategy | null
  #routes: RouteManifest | null

  constructor(
    bootFn: (port: number) => Promise<{ port: number; close: () => Promise<void> | void }>,
    options: { auth?: AuthStrategy; routes?: RouteManifest } = {},
  ) {
    this.#bootFn = bootFn
    this.#auth = options.auth ?? null
    this.#routes = options.routes ?? null
  }

  #server: { port: number; close: () => Promise<void> | void } | null = null

  /** Boot the application on a random port. */
  async boot(): Promise<void> {
    this.#server = await this.#bootFn(0)
    this.#port = this.#server.port
  }

  /** Close the server. */
  async close(): Promise<void> {
    if (this.#server) {
      await this.#server.close()
      this.#server = null
    }
  }

  /**
   * Ephemeral port the booted server bound to. Useful for long-lived
   * connections (SSE / WebSocket) that the fluent buffered request
   * surface can't model — open them with `fetch` against
   * `http://127.0.0.1:${client.port}/...`. Returns 0 before `boot()`.
   */
  get port(): number {
    return this.#port
  }

  /** Set a default header for all requests. */
  withHeader(name: string, value: string): this {
    this.#headers[name.toLowerCase()] = value
    return this
  }

  // Verb shortcuts return the RICH builder — the full japa/api-client surface
  // (assertOk/assertStatus/assertBody/… + auth/csrf) AND awaitable (`await
  // client.get('/x')` sends and resolves to the response). One unified builder,
  // no split between `get()` and `fluent()`.

  /** GET request — rich, awaitable builder. */
  get(path: string): RequestBuilder {
    return this.fluent('GET', path)
  }

  /** POST request — rich, awaitable builder. */
  post(path: string): RequestBuilder {
    return this.fluent('POST', path)
  }

  /** PUT request — rich, awaitable builder. */
  put(path: string): RequestBuilder {
    return this.fluent('PUT', path)
  }

  /** PATCH request — rich, awaitable builder. */
  patch(path: string): RequestBuilder {
    return this.fluent('PATCH', path)
  }

  /** DELETE request — rich, awaitable builder. */
  delete(path: string): RequestBuilder {
    return this.fluent('DELETE', path)
  }

  /**
   * HEAD request — japa/api-client's `.head()`. Returns the rich builder so you
   * can assert status/headers (a HEAD response carries headers, no body).
   */
  head(path: string): RequestBuilder {
    return this.fluent('HEAD', path)
  }

  /**
   * Build a request with the rich fluent surface: chained assertions
   * (`expectStatus` / `expectJson` / `expectHeader` / `expectCookie`), auth
   * injection (`withAuth` / `asUser`, needs the `auth` client option), and
   * `form()`. The lower-level `request()` (below) stays for raw control.
   */
  fluent(method: HttpMethod, path: string): RequestBuilder {
    const sender: HttpSender = (m, p, init) =>
      sendRequest(
        this.#port,
        m,
        p,
        { ...this.#headers, ...init.headers },
        init.body.toString('utf8'),
      )
    return new RequestBuilder(sender, method, path, this.#auth)
  }

  /**
   * GET a named route — japa/api-client's `.visit()`. Resolves `name` against
   * the `routes` manifest (`router.namedManifest()`), fills `:param`
   * placeholders, and returns the rich chainable builder. Throws a clear error
   * when no manifest was configured or the name is unknown.
   */
  visit(name: string, params?: Record<string, string>): RequestBuilder {
    if (!this.#routes) {
      throw new Error(
        'TestClient: visit() needs a named-route manifest. Pass `routes: router.namedManifest()` in the client options.',
      )
    }
    return this.fluent('GET', resolveNamedRoute(this.#routes, name, params))
  }

  /** Build a request with the low-level fluent API. */
  request(method: string, path: string): TestRequestBuilder {
    const headers: Dict = { ...this.#headers }
    let bodyContent = ''
    const cookies: string[] = []

    const builder: TestRequestBuilder = {
      header(name: string, value: string) {
        headers[name.toLowerCase()] = value
        return builder
      },
      json(data: unknown) {
        bodyContent = JSON.stringify(data)
        headers['content-type'] = 'application/json'
        return builder
      },
      body(content: string, contentType?: string) {
        bodyContent = content
        if (contentType) headers['content-type'] = contentType
        return builder
      },
      cookie(name: string, value: string) {
        cookies.push(`${name}=${value}`)
        return builder
      },
      send: async () => {
        if (cookies.length > 0) {
          headers.cookie = cookies.join('; ')
        }
        return sendRequest(this.#port, method, path, headers, bodyContent)
      },
      // Thenable: `await client.get('/x')` (or any builder) sends the request,
      // matching AdonisJS/japa's api-client ergonomics. The `then` IS the public
      // contract here — awaiting the builder is the documented way to send.
      // biome-ignore lint/suspicious/noThenProperty: thenable request builder is the intended API (AdonisJS/japa parity) — `await client.get(path)` sends
      then: (onfulfilled, onrejected) => builder.send().then(onfulfilled, onrejected),
    }

    return builder
  }
}

/** Create and boot a test client in one call. */
export async function createTestClient(
  bootFn: (port: number) => Promise<{ port: number; close: () => Promise<void> | void }>,
  options?: { auth?: AuthStrategy },
): Promise<TestClient> {
  const client = new TestClient(bootFn, options)
  await client.boot()
  return client
}

/** Configuration for the {@link apiClient} helix plugin. */
export interface ApiClientConfig {
  /** Boot the app under test on the given port; return the port + a close fn. */
  boot: (port: number) => Promise<{ port: number; close: () => Promise<void> | void }>
  /** Warden auth strategy for `client.withAuth()`/`asUser()`. */
  auth?: AuthStrategy
  /** Named-route manifest (`router.namedManifest()`) for `client.visit()`. */
  routes?: RouteManifest
}

/**
 * `apiClient()` — a helix plugin (Japa `@japa/api-client` parity) that injects a
 * booted {@link TestClient} on the test context as `ctx.client`:
 *
 *   // tests/bootstrap.ts
 *   import { configure } from '@c9up/helix'
 *   import { apiClient } from '@c9up/ream/testing'
 *   await configure({ plugins: [apiClient({ boot: () => bootApp() })] })
 *
 *   // a test
 *   test('health', async ({ client }) => {
 *     await client.get('/health').assertOk()
 *   })
 *
 * The server is booted once at `configure()` time and shared across the run;
 * the worker process closing releases the socket.
 */
export function apiClient(config: ApiClientConfig): Plugin {
  return async (api) => {
    const client = new TestClient(config.boot, {
      auth: config.auth,
      routes: config.routes,
    })
    await client.boot()
    api.context.macro('client', client)
  }
}

// Typing side of the plugin — importing `@c9up/ream/testing` augments the helix
// test context with `client` (the Japa pattern).
declare module '@c9up/helix' {
  interface TestContext {
    client: TestClient
  }
}

export {
  type AuthStrategy,
  type AuthSubject,
  type HttpMethod,
  type HttpSender,
  partialMatch,
  type QueryParams,
  RequestBuilder,
} from './RequestBuilder.js'

/**
 * Resolve a named route against a manifest — the client-side twin of
 * `Router.urlFor`. Fills `:param` placeholders (word-boundary safe), strips
 * unprovided `:optional?` segments, and throws on an unknown name or a missing
 * required param.
 */
export function resolveNamedRoute(
  manifest: RouteManifest,
  name: string,
  params?: Record<string, string>,
): string {
  const pattern = manifest[name]
  if (pattern === undefined) {
    const available = Object.keys(manifest).join(', ') || '(none)'
    throw new Error(`Route '${name}' not found. Available: ${available}`)
  }
  let url = pattern
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      url = url.replace(new RegExp(`:${escaped}\\??(?![\\w])`, 'g'), encodeURIComponent(value))
    }
  }
  url = url.replace(/\/:[A-Za-z_][\w]*\?/g, '')
  const missing = url.match(/:[A-Za-z_][\w]*/g)
  if (missing && missing.length > 0) {
    throw new Error(`Cannot generate URL for route '${name}': missing params ${missing.join(', ')}`)
  }
  return url
}

/** Send an HTTP request using raw TCP (no external dependencies). */
async function sendRequest(
  port: number,
  method: string,
  path: string,
  headers: Dict,
  body: string,
): Promise<TestResponse> {
  const { connect } = await import('node:net')

  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      // Build HTTP/1.1 request
      const headerLines = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')

      const contentLength = Buffer.byteLength(body, 'utf8')

      let request = `${method} ${path} HTTP/1.1\r\n`
      request += `Host: localhost:${port}\r\n`
      request += `Connection: close\r\n`
      if (contentLength > 0) {
        request += `Content-Length: ${contentLength}\r\n`
      }
      if (headerLines) {
        request += `${headerLines}\r\n`
      }
      request += '\r\n'
      request += body

      socket.write(request)
    })

    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => {
      // Keep the wire bytes as a Buffer through parseHttpResponse — chunked
      // decoding has to count bytes (per RFC 7230), not UTF-16 code units.
      // Converting to a string here used to truncate non-ASCII and binary
      // chunked responses (é / emoji / images / PDF).
      resolve(parseHttpResponse(Buffer.concat(chunks)))
    })
    socket.on('error', reject)

    // Socket inactivity timeout. 5s was too tight for real e2e flows —
    // signup hashes a password with argon2 (~50-200ms), then an INSERT
    // crosses sqlite's WAL fsync, then JWT sign + serialize. Under
    // cross-package CPU pressure (parallel helix workers, NAPI
    // tokio runtimes) the cumulative latency exceeded 5s ~30% of runs
    // and surfaced as flaky `bob accepts` / `non-member 403` failures
    // in kitchen-sink's workspace.test.ts. 30s matches the helix
    // `--timeout=60000` per-test budget without masking real hangs.
    socket.setTimeout(30_000, () => {
      socket.destroy()
      reject(new Error('TestClient request timed out'))
    })
  })
}

/**
 * Parse a raw HTTP response. Accepts the wire bytes (Buffer) or a UTF-8
 * string for back-compat with older test callers. Chunked decoding runs on
 * the Buffer to keep byte-counting honest — HTTP counts bytes (RFC 7230),
 * not UTF-16 code units, so doing the work on a `.toString('utf8')` string
 * silently truncated non-ASCII and binary responses.
 */
export function parseHttpResponse(raw: string | Buffer): TestResponse {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
  const HEADER_TERM = Buffer.from('\r\n\r\n', 'ascii')
  const headerEnd = buf.indexOf(HEADER_TERM)
  if (headerEnd === -1) {
    const body = buf.toString('utf8')
    return { status: 0, headers: {}, body, json: () => JSON.parse(body) }
  }

  // HTTP headers are ASCII (RFC 7230 §3.2); decoding via 'ascii' is safe and
  // makes any non-ASCII byte show as a question-mark, surfacing protocol bugs
  // instead of silently smuggling them.
  const headerSection = buf.subarray(0, headerEnd).toString('ascii')
  let bodyBuffer = buf.subarray(headerEnd + HEADER_TERM.length)

  const lines = headerSection.split('\r\n')
  const statusLine = lines[0] ?? ''
  const statusMatch = statusLine.match(/HTTP\/\d+\.\d+ (\d+)/)
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0

  const headers: Dict = {}
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':')
    if (colonIdx === -1) continue
    const key = lines[i].slice(0, colonIdx).trim().toLowerCase()
    const value = lines[i].slice(colonIdx + 1).trim()
    headers[key] = value
  }

  // RFC 7230 §4.1: when Transfer-Encoding includes `chunked`, the message body
  // is a sequence of `<size-hex>[;ext]\r\n<bytes>\r\n` chunks terminated by
  // `0\r\n\r\n`. Decode on the Buffer so chunk sizes (bytes) match slice
  // boundaries — character-counting corrupts é / emoji / binary payloads.
  const transferEncoding = headers['transfer-encoding'] ?? ''
  if (
    transferEncoding
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .includes('chunked')
  ) {
    bodyBuffer = decodeChunked(bodyBuffer)
    delete headers['transfer-encoding']
  }

  const body = bodyBuffer.toString('utf8')
  return {
    status,
    headers,
    body,
    json<T = unknown>(): T {
      return JSON.parse(body)
    },
  }
}

/**
 * Decode an HTTP/1.1 chunked-transfer body. Operates on a Buffer because
 * chunk sizes are byte counts per RFC 7230 — character-counting silently
 * corrupts non-ASCII / binary responses. Tolerant: stops at the first
 * malformed chunk header rather than throwing — surfacing a partial body is
 * more useful for a failing test assertion than swallowing the whole
 * response.
 */
function decodeChunked(raw: Buffer): Buffer {
  const CRLF = Buffer.from('\r\n', 'ascii')
  const out: Buffer[] = []
  let i = 0
  while (i < raw.length) {
    const lineEnd = raw.indexOf(CRLF, i)
    if (lineEnd === -1) break
    const sizeStr = raw.subarray(i, lineEnd).toString('ascii').split(';')[0]?.trim() ?? ''
    const size = Number.parseInt(sizeStr, 16)
    if (!Number.isFinite(size) || size < 0) break
    i = lineEnd + CRLF.length
    if (size === 0) break
    if (i + size > raw.length) {
      out.push(raw.subarray(i))
      break
    }
    out.push(raw.subarray(i, i + size))
    i += size + CRLF.length // chunk + trailing \r\n
  }
  return Buffer.concat(out)
}

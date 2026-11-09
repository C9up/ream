/**
 * Outbound HTTP for server code that calls a URL it does not fully control —
 * a customer's domain, a webhook target, a CMS the user pointed the app at.
 *
 * `fetch` connects wherever DNS says. A domain that resolves to `10.0.0.5`,
 * `127.0.0.1` or `169.254.169.254` makes the server read its own network on
 * the attacker's behalf (SSRF). Checking the address before the call is not
 * enough: a DNS answer can change between the check and the connection
 * (rebinding). So the check runs AT CONNECT TIME, inside the `lookup` of the
 * client's own agents — the address that is checked is the address the
 * socket connects to. The agents belong to this client alone, so a pooled
 * socket opened by other code is never reused.
 *
 * Also bounded: one deadline for the whole exchange (redirects included), a
 * maximum response size, and a few redirects, to the same host by default.
 * Every failure is an {@link HttpClientError} with a `reason`.
 *
 * No AdonisJS counterpart: the framework ships no outbound client.
 */

import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { ReamError } from '../errors/ReamError.js'
import { isPublicAddress } from './addresses.js'

/** Why an outbound request failed. */
export type HttpClientFailure =
  | 'invalidUrl'
  | 'privateAddress'
  | 'unreachable'
  | 'timedOut'
  | 'tooLarge'
  | 'redirect'

const CODES: Record<HttpClientFailure, string> = {
  invalidUrl: 'E_HTTP_CLIENT_INVALID_URL',
  privateAddress: 'E_HTTP_CLIENT_PRIVATE_ADDRESS',
  unreachable: 'E_HTTP_CLIENT_UNREACHABLE',
  timedOut: 'E_HTTP_CLIENT_TIMED_OUT',
  tooLarge: 'E_HTTP_CLIENT_TOO_LARGE',
  redirect: 'E_HTTP_CLIENT_REDIRECT_REFUSED',
}

/**
 * A failed outbound request. A `ReamError`, not an HTTP `Exception`: left
 * uncaught in a handler it answers a generic 500 and its message, which names
 * hosts and addresses, never reaches the client.
 */
export class HttpClientError extends ReamError {
  readonly reason: HttpClientFailure
  /** The target, without its query string (which may carry credentials). */
  readonly url: string

  constructor(reason: HttpClientFailure, url: URL | string, message: string, cause?: unknown) {
    const shown = describeUrl(url)
    super(CODES[reason], message, { context: { url: shown } })
    this.name = 'HttpClientError'
    this.reason = reason
    this.url = shown
    if (cause !== undefined) this.cause = cause
  }
}

export interface HttpClientOptions {
  /** Deadline for the whole exchange, redirects included, in ms. Default 10 000. */
  timeout?: number
  /** Largest response body accepted, in bytes. Default 5 MiB. */
  maxResponseBytes?: number
  /** Redirects followed before giving up. Default 3; `0` hands back the 3xx itself. */
  maxRedirects?: number
  /** Follow a redirect to another host. Default `false`. */
  crossHostRedirects?: boolean
  /** `User-Agent` sent with every request. Default `@c9up/ream`. */
  userAgent?: string
  /** Headers sent with every request (a request's own headers win). */
  headers?: Record<string, string>
  /**
   * Hosts exempt from the public-address rule, as `host` or `host:port` —
   * `'localhost:4399'` for a service running next to the app in development.
   * Exact matches only; keep it out of production configuration.
   */
  allowHosts?: string[]
}

export interface HttpRequestOptions {
  /** Default `GET`. */
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** Sent as JSON, with `content-type: application/json` unless one is given. */
  json?: unknown
  /** Abort from outside; the deadline still applies. */
  signal?: AbortSignal
  /** Overrides the client's `timeout` for this request. */
  timeout?: number
  /** Overrides the client's `maxResponseBytes` for this request. */
  maxResponseBytes?: number
}

/** One request on the wire — what {@link HttpClient.send} receives. */
export interface OutgoingRequest {
  url: URL
  method: string
  headers: Record<string, string>
  body?: Buffer
  signal: AbortSignal
  maxResponseBytes: number
}

/** A complete response, its body read and bounded. */
export class HttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[]>>
  /** The URL that answered, after redirects. */
  readonly url: string
  readonly body: Buffer

  constructor(
    status: number,
    headers: Record<string, string | string[]>,
    url: string,
    body: Buffer,
  ) {
    this.status = status
    this.headers = headers
    this.url = url
    this.body = body
  }

  /** A 2xx status. */
  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  /** A header's first value; names are case-insensitive. */
  header(name: string): string | undefined {
    const value = this.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }

  text(): string {
    return this.body.toString('utf8')
  }

  /** The body parsed as JSON — `unknown` until the caller validates it. */
  json(): unknown {
    return JSON.parse(this.text())
  }
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Headers that must not follow a redirect to another host. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

export class HttpClient {
  readonly #timeout: number
  readonly #maxResponseBytes: number
  readonly #maxRedirects: number
  readonly #crossHostRedirects: boolean
  readonly #headers: Record<string, string>
  readonly #allowHosts: ReadonlySet<string>
  #guardedAgents?: { http: http.Agent; https: https.Agent }
  #exemptAgents?: { http: http.Agent; https: https.Agent }

  constructor(options: HttpClientOptions = {}) {
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.#crossHostRedirects = options.crossHostRedirects ?? false
    this.#headers = {
      'user-agent': options.userAgent ?? '@c9up/ream',
      ...lowercaseKeys(options.headers ?? {}),
    }
    this.#allowHosts = new Set((options.allowHosts ?? []).map((entry) => entry.toLowerCase()))
  }

  get(url: string | URL, options: Omit<HttpRequestOptions, 'method'> = {}): Promise<HttpResponse> {
    return this.request(url, { ...options, method: 'GET' })
  }

  post(url: string | URL, options: Omit<HttpRequestOptions, 'method'> = {}): Promise<HttpResponse> {
    return this.request(url, { ...options, method: 'POST' })
  }

  put(url: string | URL, options: Omit<HttpRequestOptions, 'method'> = {}): Promise<HttpResponse> {
    return this.request(url, { ...options, method: 'PUT' })
  }

  patch(
    url: string | URL,
    options: Omit<HttpRequestOptions, 'method'> = {},
  ): Promise<HttpResponse> {
    return this.request(url, { ...options, method: 'PATCH' })
  }

  delete(
    url: string | URL,
    options: Omit<HttpRequestOptions, 'method'> = {},
  ): Promise<HttpResponse> {
    return this.request(url, { ...options, method: 'DELETE' })
  }

  /** Send a request, following redirects within the client's rules. */
  async request(input: string | URL, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    let url = parseTarget(input)
    let method = (options.method ?? 'GET').toUpperCase()
    let headers: Record<string, string> = {
      ...this.#headers,
      ...lowercaseKeys(options.headers ?? {}),
    }
    let body = encodeBody(options, headers)
    const maxResponseBytes = options.maxResponseBytes ?? this.#maxResponseBytes

    const timeout = options.timeout ?? this.#timeout
    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort(
        new HttpClientError('timedOut', url, `No complete response within ${timeout} ms.`),
      )
    }, timeout)
    const signal = options.signal
      ? AbortSignal.any([deadline.signal, options.signal])
      : deadline.signal

    try {
      for (let redirects = 0; ; redirects++) {
        this.#assertAddressLiteralAllowed(url)
        if (body !== undefined) headers['content-length'] = String(body.length)
        const response = await this.send({ url, method, headers, body, signal, maxResponseBytes })
        if (response.body.length > maxResponseBytes) {
          throw new HttpClientError('tooLarge', url, `Response exceeds ${maxResponseBytes} bytes.`)
        }

        const location = response.header('location')
        if (!REDIRECT_STATUSES.has(response.status) || location === undefined) return response
        if (this.#maxRedirects === 0) return response
        if (redirects >= this.#maxRedirects) {
          throw new HttpClientError('redirect', url, `More than ${this.#maxRedirects} redirects.`)
        }

        const next = parseTarget(location, url)
        if (url.protocol === 'https:' && next.protocol === 'http:') {
          throw new HttpClientError('redirect', next, 'Refused a redirect from https to http.')
        }
        if (next.host !== url.host) {
          if (!this.#crossHostRedirects) {
            throw new HttpClientError(
              'redirect',
              next,
              `Refused a redirect from ${url.host} to another host (${next.host}).`,
            )
          }
          headers = withoutKeys(headers, CREDENTIAL_HEADERS)
        }
        // What browsers and fetch do: a 303 always becomes a GET, and a
        // 301/302 does when it answered a POST. 307/308 keep method and body.
        const becomesGet =
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        if (becomesGet && method !== 'HEAD') {
          method = 'GET'
          body = undefined
          headers = withoutKeys(headers, ['content-type', 'content-length'])
        }
        url = next
      }
    } catch (error) {
      // An abort from the deadline surfaces as whatever the transport threw;
      // the deadline's own error says what happened.
      if (deadline.signal.aborted && deadline.signal.reason instanceof HttpClientError) {
        throw deadline.signal.reason
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Put one request on the wire and read its response, bounded. Redirects are
   * not followed here. Overridden by the test fake.
   */
  protected send(request: OutgoingRequest): Promise<HttpResponse> {
    const { url, method, headers, body, signal, maxResponseBytes } = request
    const agents = this.#agentsFor(url)
    const transport = url.protocol === 'https:' ? https : http
    const agent = url.protocol === 'https:' ? agents.https : agents.http

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        req.destroy()
        reject(toClientError(error, url, signal))
      }
      const onAbort = (): void => fail(signal.reason)

      const req = transport.request(url, { method, headers, agent }, (res) => {
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          fail(new HttpClientError('tooLarge', url, `Response exceeds ${maxResponseBytes} bytes.`))
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > maxResponseBytes) {
            fail(
              new HttpClientError('tooLarge', url, `Response exceeds ${maxResponseBytes} bytes.`),
            )
            return
          }
          chunks.push(chunk)
        })
        res.on('error', fail)
        res.on('close', () => {
          if (!res.complete) fail(new Error('The response was cut short.'))
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          resolve(
            new HttpResponse(
              res.statusCode ?? 0,
              copyHeaders(res.headers),
              url.href,
              Buffer.concat(chunks),
            ),
          )
        })
      })
      req.on('error', fail)
      if (signal.aborted) {
        fail(signal.reason)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      req.end(body)
    })
  }

  /** Release the pooled connections. The client stays usable; new ones are opened on demand. */
  close(): void {
    for (const agents of [this.#guardedAgents, this.#exemptAgents]) {
      agents?.http.destroy()
      agents?.https.destroy()
    }
    this.#guardedAgents = undefined
    this.#exemptAgents = undefined
  }

  #isExempt(url: URL): boolean {
    if (this.#allowHosts.size === 0) return false
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const hostname = url.hostname.toLowerCase()
    return this.#allowHosts.has(hostname) || this.#allowHosts.has(`${hostname}:${port}`)
  }

  /**
   * An address written in the URL is never looked up, so the connect-time
   * check does not see it: it is judged here, on every hop.
   */
  #assertAddressLiteralAllowed(url: URL): void {
    const address = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(address) === 0 || this.#isExempt(url)) return
    if (!isPublicAddress(address)) {
      throw new HttpClientError('privateAddress', url, `${address} is not a public address.`)
    }
  }

  #agentsFor(url: URL): { http: http.Agent; https: https.Agent } {
    if (this.#isExempt(url)) {
      this.#exemptAgents ??= {
        http: new http.Agent({ keepAlive: true }),
        https: new https.Agent({ keepAlive: true }),
      }
      return this.#exemptAgents
    }
    this.#guardedAgents ??= {
      http: new http.Agent({ keepAlive: true, lookup: publicOnlyLookup }),
      https: new https.Agent({ keepAlive: true, lookup: publicOnlyLookup }),
    }
    return this.#guardedAgents
  }
}

/**
 * `dns.lookup`, refusing the connection when ANY address the name resolves
 * to is not public — a name that answers both a public and a private address
 * is a rebinding setup, not a choice to make on the attacker's behalf.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '')
      return
    }
    const refused = addresses.find((entry) => !isPublicAddress(entry.address))
    const [first] = addresses
    if (refused !== undefined || first === undefined) {
      callback(
        new HttpClientError(
          'privateAddress',
          `http://${hostname}`,
          `${hostname} resolves to ${refused?.address ?? 'no address'}, which is not a public address.`,
        ),
        '',
      )
      return
    }
    if (options.all) callback(null, addresses)
    else callback(null, first.address, first.family)
  })
}

function parseTarget(input: string | URL, base?: URL): URL {
  let url: URL
  try {
    url = new URL(input, base)
  } catch (error) {
    throw new HttpClientError('invalidUrl', String(input), 'Not a valid URL.', error)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpClientError(
      'invalidUrl',
      url,
      `Only http and https URLs are allowed, not ${url.protocol}`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpClientError(
      'invalidUrl',
      url,
      'Credentials in the URL are refused; send a header.',
    )
  }
  return url
}

function encodeBody(
  options: HttpRequestOptions,
  headers: Record<string, string>,
): Buffer | undefined {
  if (options.json !== undefined) {
    headers['content-type'] ??= 'application/json'
    return Buffer.from(JSON.stringify(options.json), 'utf8')
  }
  if (options.body === undefined) return undefined
  return typeof options.body === 'string'
    ? Buffer.from(options.body, 'utf8')
    : Buffer.from(options.body)
}

function toClientError(error: unknown, url: URL, signal: AbortSignal): unknown {
  if (error instanceof HttpClientError) return error
  // An abort the caller asked for is theirs to recognise: hand back its reason.
  if (signal.aborted && error === signal.reason) return error
  const message = error instanceof Error ? error.message : String(error)
  return new HttpClientError('unreachable', url, `Could not reach ${url.host}: ${message}`, error)
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value
  return out
}

function withoutKeys(
  headers: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!names.includes(name)) out[name] = value
  }
  return out
}

function copyHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = value
  }
  return out
}

function describeUrl(url: URL | string): string {
  if (typeof url === 'string') {
    try {
      return describeUrl(new URL(url))
    } catch {
      return url.split('?')[0] ?? url
    }
  }
  return `${url.origin}${url.pathname}`
}

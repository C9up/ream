/**
 * An {@link HttpClient} that never touches the network, for tests.
 *
 * It is a real client with the transport swapped: URL validation, the
 * address-literal rule, the size limit and the redirect policy all still
 * apply, so a test sees the same refusals production would. Only the wire is
 * replaced — canned responses in, recorded requests out.
 *
 *   const http = fakeHttp()
 *   http.on('GET', 'https://cms.example.com/api/posts', { json: [{ id: 1 }] })
 *   await new CmsReader(http).posts()
 *   expect(http.requests).toHaveLength(1)
 */

import {
  HttpClient,
  HttpClientError,
  type HttpClientOptions,
  HttpResponse,
  type OutgoingRequest,
} from './HttpClient.js'

/** What a faked endpoint answers. */
export interface FakeResponse {
  /** Default 200. */
  status?: number
  headers?: Record<string, string | string[]>
  body?: string | Uint8Array
  /** Serialised as the body, with `content-type: application/json`. */
  json?: unknown
}

/** A request the fake received. */
export interface RecordedRequest {
  method: string
  url: string
  headers: Readonly<Record<string, string>>
  body: Buffer | undefined
}

/** An exact URL (with or without its query string), a pattern, or a predicate. */
export type FakeMatcher = string | RegExp | ((request: RecordedRequest) => boolean)

interface FakeRoute {
  method: string | undefined
  match: FakeMatcher
  respond: FakeResponse | ((request: RecordedRequest) => FakeResponse)
}

export class FakeHttpClient extends HttpClient {
  /** Every request sent, in order — redirect hops included. */
  readonly requests: RecordedRequest[] = []
  readonly #routes: FakeRoute[] = []

  /**
   * Answer `method` + `match` with `response`. The most recent matching
   * registration wins, so a test can override a default set up earlier.
   */
  on(
    method: string,
    match: FakeMatcher,
    response: FakeResponse | ((request: RecordedRequest) => FakeResponse),
  ): this {
    this.#routes.push({ method: method.toUpperCase(), match, respond: response })
    return this
  }

  /** Answer `match` whatever the method. */
  onAny(
    match: FakeMatcher,
    response: FakeResponse | ((request: RecordedRequest) => FakeResponse),
  ): this {
    this.#routes.push({ method: undefined, match, respond: response })
    return this
  }

  /** Forget the registered responses and the recorded requests. */
  reset(): void {
    this.#routes.length = 0
    this.requests.length = 0
  }

  protected override async send(request: OutgoingRequest): Promise<HttpResponse> {
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url.href,
      headers: { ...request.headers },
      body: request.body,
    }
    this.requests.push(recorded)

    const route = this.#latestRoute(recorded, request.url)
    if (route === undefined) {
      throw new HttpClientError(
        'unreachable',
        request.url,
        `No fake response for ${recorded.method} ${recorded.url}.`,
      )
    }
    const answer = typeof route.respond === 'function' ? route.respond(recorded) : route.respond
    const headers: Record<string, string | string[]> = {}
    const given: Record<string, string | string[]> = answer.headers ?? {}
    for (const [name, value] of Object.entries(given)) {
      headers[name.toLowerCase()] = value
    }
    let body: Buffer
    if (answer.json !== undefined) {
      headers['content-type'] ??= 'application/json'
      body = Buffer.from(JSON.stringify(answer.json), 'utf8')
    } else if (answer.body === undefined) {
      body = Buffer.alloc(0)
    } else {
      body =
        typeof answer.body === 'string'
          ? Buffer.from(answer.body, 'utf8')
          : Buffer.from(answer.body)
    }
    return new HttpResponse(answer.status ?? 200, headers, request.url.href, body)
  }

  #latestRoute(request: RecordedRequest, url: URL): FakeRoute | undefined {
    for (let i = this.#routes.length - 1; i >= 0; i--) {
      const candidate = this.#routes[i]
      if (candidate === undefined) continue
      if (candidate.method !== undefined && candidate.method !== request.method) continue
      if (matches(candidate.match, request, url)) return candidate
    }
    return undefined
  }
}

function matches(match: FakeMatcher, request: RecordedRequest, url: URL): boolean {
  if (typeof match === 'function') return match(request)
  if (match instanceof RegExp) return match.test(request.url)
  return match === url.href || match === `${url.origin}${url.pathname}`
}

/** A fresh {@link FakeHttpClient}, with the same options a real client takes. */
export function fakeHttp(options: HttpClientOptions = {}): FakeHttpClient {
  return new FakeHttpClient(options)
}

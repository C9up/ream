/**
 * Unified Context for HTTP requests and bus events.
 *
 * @implements FR21
 *
 * Middleware and handlers receive this context regardless of transport.
 */

export interface AuthState {
  authenticated: boolean
  userId?: string
  roles?: string[]
}

export class Context {
  /** Unique request/event ID (correlation ID). */
  readonly id: string

  /** Authentication state. */
  auth: AuthState = { authenticated: false }

  /** Detected locale (from Accept-Language or config). */
  locale = 'en'

  /** Transport type. */
  readonly type: 'http' | 'event'

  /** HTTP-specific data (present when type === 'http'). */
  request?: {
    method: string
    path: string
    query: string
    headers: Record<string, string>
    body: string
  }

  /** Response builder (present when type === 'http'). */
  response?: {
    status: number
    headers: Record<string, string>
    body: string
  }

  /** Route parameters (present when type === 'http'). */
  params?: Record<string, string>

  /** Event-specific data (present when type === 'event'). */
  event?: {
    name: string
    data: string
    correlationId: string
    causationId?: string
  }

  /** Source service info (present when type === 'event'). */
  service?: {
    name: string
  }

  constructor(type: 'http' | 'event', id: string) {
    this.type = type
    this.id = id
  }

  /** Check transport type. */
  is(type: 'http' | 'event'): boolean {
    return this.type === type
  }

  /** Create an HTTP context. */
  static http(
    id: string,
    request: NonNullable<Context['request']>,
  ): Context {
    const ctx = new Context('http', id)
    ctx.request = request
    ctx.response = { status: 200, headers: {}, body: '' }
    return ctx
  }

  /** Create an event context. */
  static event(
    id: string,
    event: NonNullable<Context['event']>,
    serviceName?: string,
  ): Context {
    const ctx = new Context('event', id)
    ctx.event = event
    if (serviceName) {
      ctx.service = { name: serviceName }
    }
    return ctx
  }
}

/**
 * Request — wraps raw HTTP request data from the NAPI layer.
 *
 * Provides a fluent, AdonisJS-compatible API for reading request data.
 * JSON body parsing is lazy — deferred until first access via input()/all()/body().
 *
 * @implements FR21
 */

export interface RawRequest {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
}

export class Request {
  private _raw: RawRequest
  private _params: Record<string, string>
  private _parsedBody: Record<string, unknown> | undefined
  private _parsedQs: Record<string, unknown> | undefined
  private _merged: Record<string, unknown> | undefined

  constructor(raw: RawRequest, params: Record<string, string>) {
    this._raw = raw
    this._params = params
  }

  // ─── HTTP accessors ───────────────────────────────────────

  /** HTTP method (GET, POST, etc.). */
  method(): string {
    return this._raw.method
  }

  /** Request URL (path + query string). */
  url(includeQs = true): string {
    if (includeQs && this._raw.query) {
      return `${this._raw.path}?${this._raw.query}`
    }
    return this._raw.path
  }

  /** Request path (without query string). */
  path(): string {
    return this._raw.path
  }

  /** Client IP address (from x-forwarded-for or x-real-ip). */
  ip(): string {
    return this._raw.headers['x-forwarded-for']?.split(',')[0]?.trim()
      ?? this._raw.headers['x-real-ip']
      ?? '127.0.0.1'
  }

  // ─── Headers ──────────────────────────────────────────────

  /** Get a single request header (case-insensitive). */
  header(key: string): string | undefined {
    return this._raw.headers[key.toLowerCase()]
  }

  /** Get all request headers. */
  headers(): Readonly<Record<string, string>> {
    return this._raw.headers
  }

  // ─── Route params ─────────────────────────────────────────

  /** Get a single route parameter. */
  param(key: string, defaultValue?: string): string | undefined {
    return this._params[key] ?? defaultValue
  }

  /** Get all route parameters. */
  params(): Readonly<Record<string, string>> {
    return this._params
  }

  // ─── Query string ─────────────────────────────────────────

  /** Get parsed query string as an object. */
  qs(): Record<string, unknown> {
    if (!this._parsedQs) {
      this._parsedQs = parseQueryString(this._raw.query)
    }
    return { ...this._parsedQs }
  }

  // ─── Body ─────────────────────────────────────────────────

  /** Get the parsed request body. */
  body(): unknown {
    this.ensureParsedBody()
    return this._parsedBody
  }

  /** Get the raw body string. */
  raw(): string {
    return this._raw.body
  }

  // ─── Merged input (body + qs) ─────────────────────────────

  /** Get a single input value from body or query string. */
  input<T = unknown>(key: string, defaultValue?: T): T {
    const merged = this.all()
    if (key in merged) return merged[key] as T
    return defaultValue as T
  }

  /** Get all input (query string merged with body). */
  all(): Record<string, unknown> {
    if (!this._merged) {
      this.ensureParsedBody()
      this._merged = { ...this.qs(), ...this._parsedBody }
    }
    return { ...this._merged }
  }

  /** Cherry-pick specific keys from input. */
  only<K extends string>(keys: K[]): Record<K, unknown> {
    const merged = this.all()
    const result = {} as Record<K, unknown>
    for (const key of keys) {
      if (key in merged) {
        result[key] = merged[key]
      }
    }
    return result
  }

  /** Get all input except specific keys. */
  except(keys: string[]): Record<string, unknown> {
    const merged = this.all()
    const keySet = new Set(keys)
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(merged)) {
      if (!keySet.has(k)) result[k] = v
    }
    return result
  }

  // ─── Content negotiation ──────────────────────────────────

  /** Check if the request content-type matches any of the given types. */
  is(types: string[]): string | null {
    const ct = this._raw.headers['content-type'] ?? ''
    for (const type of types) {
      if (type === 'json' && ct.includes('application/json')) return 'json'
      if (type === 'html' && ct.includes('text/html')) return 'html'
      if (type === 'xml' && ct.includes('xml')) return 'xml'
      if (type === 'multipart' && ct.includes('multipart/form-data')) return 'multipart'
      if (ct.includes(type)) return type
    }
    return null
  }

  /** Content negotiation — which of the given types does the client accept? */
  accepts(types: string[]): string | null {
    const accept = this._raw.headers['accept'] ?? '*/*'
    for (const type of types) {
      if (accept === '*/*') return type
      if (type === 'json' && (accept.includes('application/json') || accept.includes('*/*'))) return 'json'
      if (type === 'html' && (accept.includes('text/html') || accept.includes('*/*'))) return 'html'
      if (type === 'xml' && accept.includes('xml')) return 'xml'
      if (accept.includes(type)) return type
    }
    return null
  }

  /** Language negotiation from Accept-Language. */
  language(langs: string[]): string | null {
    const acceptLang = this._raw.headers['accept-language'] ?? ''
    for (const lang of langs) {
      if (acceptLang.includes(lang)) return lang
    }
    return langs[0] ?? null
  }

  // ─── Internals ────────────────────────────────────────────

  private ensureParsedBody(): void {
    if (this._parsedBody !== undefined) return
    const raw = this._raw.body
    if (!raw || raw.length === 0) {
      this._parsedBody = {}
      return
    }
    try {
      const parsed = JSON.parse(raw)
      this._parsedBody = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { _body: parsed }
    } catch {
      this._parsedBody = {}
    }
  }
}

/** Parse a query string (key=value&key2=value2) into an object. */
function parseQueryString(qs: string): Record<string, unknown> {
  if (!qs) return {}
  const result: Record<string, unknown> = {}
  for (const pair of qs.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      result[decodeURIComponent(pair)] = ''
    } else {
      const key = decodeURIComponent(pair.slice(0, eqIdx))
      const value = decodeURIComponent(pair.slice(eqIdx + 1))
      result[key] = value
    }
  }
  return result
}

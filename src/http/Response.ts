/**
 * Response — accumulates HTTP response state with a fluent API.
 *
 * Wraps the same { status, headers, body } wire format expected by the NAPI layer.
 * Provides AdonisJS-compatible methods: json(), send(), status(), header(), etc.
 *
 * @implements FR21
 */

import type { RedirectBuilder } from './RedirectBuilder.js'

export class Response {
  private _status = 200
  private _headers: Record<string, string> = {}
  private _body = ''
  private _finished = false
  private _redirectBuilderFactory?: () => RedirectBuilder

  // ─── Status ───────────────────────────────────────────────

  /** Set the HTTP status code. Chainable. */
  status(code: number): this {
    this._status = code
    return this
  }

  /** Set status only if not already set (still 200). */
  safeStatus(code: number): this {
    if (this._status === 200) {
      this._status = code
    }
    return this
  }

  // ─── Headers ──────────────────────────────────────────────

  /** Set a response header. Chainable. */
  header(key: string, value: string): this {
    this._headers[key.toLowerCase()] = value
    return this
  }

  /** Append to a response header (for multi-value like Set-Cookie). */
  append(key: string, value: string): this {
    const k = key.toLowerCase()
    const existing = this._headers[k]
    this._headers[k] = existing ? `${existing}, ${value}` : value
    return this
  }

  /** Remove a response header. */
  removeHeader(key: string): this {
    delete this._headers[key.toLowerCase()]
    return this
  }

  /** Set the Content-Type header. Chainable. */
  type(contentType: string): this {
    this._headers['content-type'] = contentType
    return this
  }

  // ─── Body ─────────────────────────────────────────────────

  /** Send a JSON response. Sets content-type and stringifies. */
  json(data: unknown): void {
    this._headers['content-type'] = 'application/json'
    this._body = JSON.stringify(data)
    this._finished = true
  }

  /** Send a response body. Auto-detects content type if not set. */
  send(data: unknown): void {
    if (typeof data === 'string') {
      if (!this._headers['content-type']) {
        this._headers['content-type'] = 'text/html; charset=utf-8'
      }
      this._body = data
    } else if (typeof data === 'object' && data !== null) {
      this._headers['content-type'] = 'application/json'
      this._body = JSON.stringify(data)
    } else if (data !== undefined && data !== null) {
      if (!this._headers['content-type']) {
        this._headers['content-type'] = 'text/plain'
      }
      this._body = String(data)
    }
    this._finished = true
  }

  /** Send 204 No Content. */
  noContent(): void {
    this._status = 204
    this._body = ''
    this._finished = true
  }

  // ─── Redirect ─────────────────────────────────────────────

  /** Get a redirect builder. */
  redirect(): RedirectBuilder {
    if (this._redirectBuilderFactory) {
      return this._redirectBuilderFactory()
    }
    // Lazy import to avoid circular dependency
    const { RedirectBuilder: RB } = require('./RedirectBuilder.js') as typeof import('./RedirectBuilder.js')
    return new RB(this)
  }

  /** @internal Set the redirect builder factory (injected by HttpContext). */
  _setRedirectFactory(factory: () => RedirectBuilder): void {
    this._redirectBuilderFactory = factory
  }

  // ─── Cookies (future) ─────────────────────────────────────

  /** Set a response cookie. */
  cookie(name: string, value: string, options?: { maxAge?: number; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none' }): this {
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`]
    if (options?.maxAge) parts.push(`Max-Age=${options.maxAge}`)
    if (options?.path) parts.push(`Path=${options.path}`)
    if (options?.httpOnly !== false) parts.push('HttpOnly')
    if (options?.secure) parts.push('Secure')
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`)
    return this.append('set-cookie', parts.join('; '))
  }

  // ─── Internals (used by HttpKernel for NAPI serialization) ─

  /** @internal Get the accumulated status code. */
  getStatus(): number {
    return this._status
  }

  /** @internal Get all accumulated headers. */
  getHeaders(): Record<string, string> {
    return { ...this._headers }
  }

  /** @internal Get the accumulated body string. */
  getBody(): string {
    return this._body
  }

  /** @internal Check if response has been finalized. */
  isFinished(): boolean {
    return this._finished
  }

  /** @internal Set body directly (used by redirect, exception handler). */
  _setBody(body: string): void {
    this._body = body
    this._finished = true
  }
}

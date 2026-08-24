/**
 * RedirectBuilder — fluent API for building redirect responses.
 *
 * Usage:
 *   response.redirect().toPath('/login')
 *   response.redirect().status(301).toPath('/new-url')
 *   response.redirect().back()
 *   response.redirect().withQs({ page: '2' }).toPath('/results')
 *   response.redirect().toRoute('posts.show', { id: '42' })
 */

import type { Response } from './Response.js'

export type RouteUrlResolver = (name: string, params?: Record<string, string>) => string

function isSameOriginOrRelative(referer: string, requestUrl?: string): boolean {
  // A relative path is trusted only when it starts with a single "/" and has no
  // backslash: browsers normalise "\" to "/", so "/\evil.com" would become the
  // protocol-relative "//evil.com" that a lone `!startsWith("//")` check misses.
  if (referer.startsWith('/') && !referer.startsWith('//') && !referer.includes('\\')) return true
  if (!requestUrl) return false
  try {
    const ref = new URL(referer)
    const req = new URL(requestUrl)
    return ref.origin === req.origin
  } catch {
    return false
  }
}

/** The slice of the session the intended-URL methods use. */
export interface IntendedUrlStore {
  setIntendedUrl(url: string): void
  pullIntendedUrl(): string | null
}

export class RedirectBuilder {
  #response: Response
  #status = 302
  #qs: Record<string, unknown> = {}
  #forwardQs = false
  #requestUrl?: string
  #requestReferer?: string
  #routeUrlResolver?: RouteUrlResolver
  #session?: IntendedUrlStore
  #isAjax = false
  #hasRoute = true

  constructor(
    response: Response,
    options?: {
      requestUrl?: string
      requestReferer?: string
      routeUrlResolver?: RouteUrlResolver
      /** The request session, for the intended-URL methods. */
      session?: IntendedUrlStore
      /** Whether this is an XHR — `withIntendedUrl` skips those. */
      isAjax?: boolean
      /** Whether a route matched — `withIntendedUrl` skips 404s. */
      hasRoute?: boolean
    },
  ) {
    this.#response = response
    this.#requestUrl = options?.requestUrl
    this.#requestReferer = options?.requestReferer
    this.#routeUrlResolver = options?.routeUrlResolver
    this.#session = options?.session
    this.#isAjax = options?.isAjax ?? false
    this.#hasRoute = options?.hasRoute ?? true
  }

  /**
   * Remember where the user was heading, then carry on redirecting — AdonisJS'
   * `withIntendedUrl` (a macro `@adonisjs/session` adds to Redirect).
   *
   * Only a GET, non-XHR, route-matched request is stored, exactly as upstream:
   * remembering a POST would replay it as a GET after login, and remembering a
   * 404 would send the user back to a dead end.
   */
  withIntendedUrl(method = 'GET'): this {
    if (
      this.#session &&
      method.toUpperCase() === 'GET' &&
      !this.#isAjax &&
      this.#hasRoute &&
      this.#requestUrl
    ) {
      this.#session.setIntendedUrl(this.#requestUrl)
    }
    return this
  }

  /**
   * Redirect to the remembered URL, consuming it — AdonisJS' `toIntended`.
   *
   * The stored value is validated before use: it is written from a request URL,
   * but a session store is not a trust boundary, and a redirect to an absolute
   * off-site URL is an open redirect. Anything not same-origin or relative
   * falls back, which is what `back()` already does with the Referer.
   */
  toIntended(fallback = '/'): void {
    const intended = this.#session?.pullIntendedUrl() ?? null
    this.toPath(this.#safeIntended(intended, fallback))
  }

  /** `toIntended`, falling back to a named route — AdonisJS' `toIntendedRoute`. */
  toIntendedRoute(name: string, params?: Record<string, string>): void {
    const intended = this.#session?.pullIntendedUrl() ?? null
    const safe = intended === null ? null : this.#safeIntended(intended, null)
    if (safe !== null) {
      this.toPath(safe)
      return
    }
    this.toRoute(name, params)
  }

  #safeIntended<T extends string | null>(intended: string | null, fallback: T): string | T {
    if (!intended) return fallback
    if (this.#requestUrl && !isSameOriginOrRelative(intended, this.#requestUrl)) {
      return fallback
    }
    // A protocol-relative `//evil.com` is absolute to a browser even though it
    // looks relative — reject it whether or not a request URL is known.
    if (intended.startsWith('//')) return fallback
    return intended
  }

  /** Set redirect status code. */
  status(code: number): this {
    this.#status = code
    return this
  }

  /**
   * Query string for the redirect target, in the four shapes AdonisJS accepts:
   *
   *   withQs()                 forward the request's own query string
   *   withQs(false)            stop forwarding it
   *   withQs({ a: 1, b: 2 })   merge these values in
   *   withQs('a', 1)           set one value
   *
   * The object and name/value forms MERGE, as upstream does — calling it twice
   * adds to what is there rather than replacing it.
   */
  withQs(): this
  withQs(forward: boolean): this
  withQs(values: Record<string, unknown>): this
  withQs(name: string, value: unknown): this
  withQs(name?: boolean | string | Record<string, unknown>, value?: unknown): this {
    if (name === undefined) {
      this.#forwardQs = true
      return this
    }
    if (typeof name === 'boolean') {
      this.#forwardQs = name
      return this
    }
    if (typeof name === 'string') {
      this.#qs[name] = value
      return this
    }
    Object.assign(this.#qs, name)
    return this
  }

  /** Drop every value added with {@link withQs}, and stop forwarding. */
  clearQs(): this {
    this.#qs = {}
    this.#forwardQs = false
    return this
  }

  /** Redirect to an absolute or relative path. */
  toPath(path: string): void {
    const url = this.#appendQs(path)
    this.#response.status(this.#status)
    this.#response.header('location', url)
    this.#response.setBody('')
  }

  /** Redirect to a named route. */
  toRoute(name: string, params?: Record<string, string>): void {
    if (!this.#routeUrlResolver) {
      throw new Error('Route URL resolver not configured. Cannot redirect to named route.')
    }
    const path = this.#routeUrlResolver(name, params)
    this.toPath(path)
  }

  /**
   * Redirect back to the previous page (Referer header).
   * Only trusts same-origin or relative referers — external URLs fall back
   * to `fallback` to prevent open redirect attacks.
   */
  back(fallback = '/'): void {
    const referer = this.#requestReferer
    if (referer && isSameOriginOrRelative(referer, this.#requestUrl)) {
      this.toPath(referer)
    } else {
      this.toPath(fallback)
    }
  }

  /**
   * Forwarded query string first, explicit values on top — the order AdonisJS
   * uses, so `withQs()` plus `withQs('page', 2)` overrides an inbound `page`
   * rather than being overridden by it.
   */
  #appendQs(path: string): string {
    const params = new URLSearchParams()
    if (this.#forwardQs && this.#requestUrl) {
      const qsIdx = this.#requestUrl.indexOf('?')
      if (qsIdx !== -1) {
        for (const [key, value] of new URLSearchParams(this.#requestUrl.slice(qsIdx + 1))) {
          params.append(key, value)
        }
      }
    }
    for (const [key, value] of Object.entries(this.#qs)) {
      if (value === undefined || value === null) continue
      params.set(key, String(value))
    }
    const qs = params.toString()
    if (!qs) return path
    return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
  }
}

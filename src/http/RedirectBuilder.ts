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

/**
 * AdonisJS `isValidRedirectUrl`: a relative path, or an absolute URL whose host
 * is the request authority or an allowed host.
 */
function isTrustedRedirect(
  url: string,
  authority: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  // A relative path is trusted only when it starts with a single "/" and has no
  // backslash: browsers normalise "\" to "/", so "/\evil.com" would become the
  // protocol-relative "//evil.com" that a lone `!startsWith("//")` check misses.
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // Only a web URL is a redirect target: `javascript://app.test/%0aalert(1)`
  // has the right host and is a script, not a page.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (allowedHosts.includes(parsed.host)) return true
  // Upstream accepts any absolute URL when it knows no host to compare with;
  // refusing it is the safer reading of an attacker-controlled header.
  return authority !== undefined && parsed.host === authority
}

/** The query string of a path or URL, without the "?". */
function searchOf(url: string | undefined): string {
  if (url === undefined) return ''
  const index = url.indexOf('?')
  return index === -1 ? '' : url.slice(index + 1)
}

/** The slice of the session the intended-URL methods use. */
export interface IntendedUrlStore {
  setIntendedUrl(url: string): void
  pullIntendedUrl(): string | null
}

export class RedirectBuilder {
  /**
   * Hosts a redirect-back may leave the origin for (AdonisJS `allowedHosts`).
   *
   * Empty by default, which keeps `back()` same-origin only — an open-redirect
   * is exactly what an unvalidated Referer buys.
   */
  allowedHosts: string[] = []

  #response: Response
  #status = 302
  #qs: Record<string, unknown> = {}
  #forwardQs = false
  #requestUrl?: string
  #requestReferer?: string
  #requestAuthority?: string
  #routeUrlResolver?: RouteUrlResolver
  #session?: IntendedUrlStore
  #isAjax = false
  #hasRoute = true

  constructor(
    response: Response,
    options?: {
      /** The request path with its query string. */
      requestUrl?: string
      requestReferer?: string
      /**
       * The request authority (`:authority` or `Host`, never X-Forwarded-Host)
       * an absolute redirect target must match.
       */
      requestAuthority?: string
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
    this.#requestAuthority = options?.requestAuthority
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
    return isTrustedRedirect(intended, this.#requestAuthority, this.allowedHosts)
      ? intended
      : fallback
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
    this.#send(path, searchOf(this.#requestUrl))
  }

  /** Redirect with `withQs()` forwarding `forwardedSearch` (a query string without "?"). */
  #send(path: string, forwardedSearch: string): void {
    const url = this.#appendQs(path, forwardedSearch)
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
   * Redirect back to the previous page (AdonisJS `back`): the path of
   * {@link getPreviousUrl}, so the redirect never leaves the site; `withQs()`
   * forwards the previous page's query string, not the current request's.
   */
  back(fallback = '/'): void {
    const previous = new URL(this.getPreviousUrl(fallback), 'http://localhost')
    this.#send(previous.pathname, previous.search.slice(1))
  }

  /**
   * Where "back" goes (AdonisJS `getPreviousUrl`).
   *
   * Reads the Referer and validates its host, returning `fallback` when there
   * is nothing trustworthy. Public and overridable on purpose: resolving the
   * previous URL from the session instead of the header is the documented
   * reason to replace it.
   */
  getPreviousUrl(fallback = '/'): string {
    const referer = this.#requestReferer
    if (referer && isTrustedRedirect(referer, this.#requestAuthority, this.allowedHosts)) {
      return referer
    }
    return fallback
  }

  /**
   * Forwarded query string first, explicit values on top — the order AdonisJS
   * uses, so `withQs()` plus `withQs('page', 2)` overrides an inbound `page`
   * rather than being overridden by it.
   */
  #appendQs(path: string, forwardedSearch: string): string {
    const params = new URLSearchParams()
    if (this.#forwardQs) {
      for (const [key, value] of new URLSearchParams(forwardedSearch)) params.append(key, value)
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

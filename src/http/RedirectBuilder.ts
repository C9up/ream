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

export class RedirectBuilder {
  #response: Response
  #status = 302
  #qs: Record<string, unknown> = {}
  #forwardQs = false
  #requestUrl?: string
  #requestReferer?: string
  #routeUrlResolver?: RouteUrlResolver

  constructor(
    response: Response,
    options?: {
      requestUrl?: string
      requestReferer?: string
      routeUrlResolver?: RouteUrlResolver
    },
  ) {
    this.#response = response
    this.#requestUrl = options?.requestUrl
    this.#requestReferer = options?.requestReferer
    this.#routeUrlResolver = options?.routeUrlResolver
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

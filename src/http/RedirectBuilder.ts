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

export class RedirectBuilder {
  #response: Response
  #status = 302
  #qs: Record<string, string> | null = null
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

  /** Forward current query string to the redirect target. */
  withQs(qs?: Record<string, string>): this {
    if (qs) {
      this.#qs = qs
    } else {
      this.#forwardQs = true
    }
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

  /** Redirect back to the previous page (Referer header). */
  back(fallback = '/'): void {
    const referer = this.#requestReferer ?? fallback
    this.toPath(referer)
  }

  #appendQs(path: string): string {
    let qs = ''
    if (this.#qs) {
      qs = new URLSearchParams(this.#qs).toString()
    } else if (this.#forwardQs && this.#requestUrl) {
      const qsIdx = this.#requestUrl.indexOf('?')
      if (qsIdx !== -1) qs = this.#requestUrl.slice(qsIdx + 1)
    }
    if (!qs) return path
    return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
  }
}

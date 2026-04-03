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
  private response: Response
  private _status = 302
  private _qs: Record<string, string> | null = null
  private _forwardQs = false
  private _requestUrl?: string
  private _requestReferer?: string
  private _routeUrlResolver?: RouteUrlResolver

  constructor(response: Response, options?: {
    requestUrl?: string
    requestReferer?: string
    routeUrlResolver?: RouteUrlResolver
  }) {
    this.response = response
    this._requestUrl = options?.requestUrl
    this._requestReferer = options?.requestReferer
    this._routeUrlResolver = options?.routeUrlResolver
  }

  /** Set redirect status code. */
  status(code: number): this {
    this._status = code
    return this
  }

  /** Forward current query string to the redirect target. */
  withQs(qs?: Record<string, string>): this {
    if (qs) {
      this._qs = qs
    } else {
      this._forwardQs = true
    }
    return this
  }

  /** Redirect to an absolute or relative path. */
  toPath(path: string): void {
    const url = this.appendQs(path)
    this.response.status(this._status)
    this.response.header('location', url)
    this.response._setBody('')
  }

  /** Redirect to a named route. */
  toRoute(name: string, params?: Record<string, string>): void {
    if (!this._routeUrlResolver) {
      throw new Error('Route URL resolver not configured. Cannot redirect to named route.')
    }
    const path = this._routeUrlResolver(name, params)
    this.toPath(path)
  }

  /** Redirect back to the previous page (Referer header). */
  back(fallback = '/'): void {
    const referer = this._requestReferer ?? fallback
    this.toPath(referer)
  }

  private appendQs(path: string): string {
    let qs = ''
    if (this._qs) {
      qs = new URLSearchParams(this._qs).toString()
    } else if (this._forwardQs && this._requestUrl) {
      const qsIdx = this._requestUrl.indexOf('?')
      if (qsIdx !== -1) qs = this._requestUrl.slice(qsIdx + 1)
    }
    if (!qs) return path
    return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
  }
}

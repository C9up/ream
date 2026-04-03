/**
 * Security headers middleware — sets protective HTTP headers (like Helmet).
 *
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY / SAMEORIGIN
 * - X-XSS-Protection: 0 (modern CSP replaces this)
 * - Strict-Transport-Security (HSTS)
 * - Content-Security-Policy
 * - Referrer-Policy
 * - Permissions-Policy
 * - X-DNS-Prefetch-Control
 *
 * Configured via config/security.ts.
 */

import type { HttpContext } from '../http/HttpContext.js'

export interface SecurityHeadersConfig {
  contentTypeOptions?: boolean
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  hsts?: { maxAge: number; includeSubDomains?: boolean; preload?: boolean } | false
  csp?: string | false
  referrerPolicy?: string
  permissionsPolicy?: string
  dnsPrefetch?: boolean
  crossOriginOpenerPolicy?: string
  crossOriginResourcePolicy?: string
}

const DEFAULTS: SecurityHeadersConfig = {
  contentTypeOptions: true,
  frameOptions: 'SAMEORIGIN',
  hsts: { maxAge: 15552000, includeSubDomains: true },
  csp: "default-src 'self'",
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: 'camera=(), microphone=(), geolocation=()',
  dnsPrefetch: false,
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin',
}

export default class SecurityHeadersMiddleware {
  private config: SecurityHeadersConfig

  constructor(config?: SecurityHeadersConfig) {
    this.config = { ...DEFAULTS, ...config }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    if (this.config.contentTypeOptions) {
      ctx.response.header('x-content-type-options', 'nosniff')
    }

    if (this.config.frameOptions) {
      ctx.response.header('x-frame-options', this.config.frameOptions)
    }

    // Modern browsers should use CSP, not X-XSS-Protection
    ctx.response.header('x-xss-protection', '0')

    if (this.config.hsts) {
      let value = `max-age=${this.config.hsts.maxAge}`
      if (this.config.hsts.includeSubDomains) value += '; includeSubDomains'
      if (this.config.hsts.preload) value += '; preload'
      ctx.response.header('strict-transport-security', value)
    }

    if (this.config.csp) {
      ctx.response.header('content-security-policy', this.config.csp)
    }

    if (this.config.referrerPolicy) {
      ctx.response.header('referrer-policy', this.config.referrerPolicy)
    }

    if (this.config.permissionsPolicy) {
      ctx.response.header('permissions-policy', this.config.permissionsPolicy)
    }

    if (this.config.dnsPrefetch === false) {
      ctx.response.header('x-dns-prefetch-control', 'off')
    }

    if (this.config.crossOriginOpenerPolicy) {
      ctx.response.header('cross-origin-opener-policy', this.config.crossOriginOpenerPolicy)
    }

    if (this.config.crossOriginResourcePolicy) {
      ctx.response.header('cross-origin-resource-policy', this.config.crossOriginResourcePolicy)
    }

    await next()
  }
}

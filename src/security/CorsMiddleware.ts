/**
 * CORS middleware — Cross-Origin Resource Sharing.
 *
 * Configured via config/cors.ts:
 *   export default {
 *     origin: ['https://app.example.com'],
 *     methods: ['GET', 'POST', 'PUT', 'DELETE'],
 *     headers: ['Content-Type', 'Authorization'],
 *     credentials: true,
 *     maxAge: 86400,
 *   }
 */

import type { HttpContext } from '../http/HttpContext.js'

export interface CorsConfig {
  origin: string | string[] | boolean | ((origin: string) => boolean)
  methods?: string[]
  headers?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  maxAge?: number
}

export default class CorsMiddleware {
  private config: CorsConfig

  constructor(config?: CorsConfig) {
    this.config = config ?? { origin: false }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const requestOrigin = ctx.request.header('origin') ?? ''

    const allowed = this.isOriginAllowed(requestOrigin)
    if (allowed) {
      ctx.response.header('access-control-allow-origin', typeof allowed === 'string' ? allowed : requestOrigin)
      if (this.config.credentials) {
        ctx.response.header('access-control-allow-credentials', 'true')
      }
      if (this.config.exposedHeaders?.length) {
        ctx.response.header('access-control-expose-headers', this.config.exposedHeaders.join(', '))
      }
    }

    // Preflight
    if (ctx.request.method() === 'OPTIONS') {
      if (allowed) {
        const methods = this.config.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
        ctx.response.header('access-control-allow-methods', methods.join(', '))
        const headers = this.config.headers ?? ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
        ctx.response.header('access-control-allow-headers', headers.join(', '))
        if (this.config.maxAge) {
          ctx.response.header('access-control-max-age', String(this.config.maxAge))
        }
      }
      ctx.response.status(204).send('')
      return
    }

    await next()
  }

  private isOriginAllowed(origin: string): string | boolean {
    if (!origin) return false
    const cfg = this.config.origin
    if (cfg === true || cfg === '*') return '*'
    if (cfg === false) return false
    if (typeof cfg === 'string') return cfg === origin ? origin : false
    if (typeof cfg === 'function') return cfg(origin) ? origin : false
    if (Array.isArray(cfg)) return cfg.includes(origin) ? origin : false
    return false
  }
}

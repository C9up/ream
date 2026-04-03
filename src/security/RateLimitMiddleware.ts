/**
 * Rate limiting middleware — IP-based request throttling.
 *
 * Uses an in-memory store. For distributed systems, use Redis.
 *
 * Configured via config/rateLimit.ts:
 *   export default {
 *     max: 100,       // max requests per window
 *     window: 60,     // window in seconds
 *   }
 */

import type { HttpContext } from '../http/HttpContext.js'

export interface RateLimitConfig {
  max?: number
  window?: number // seconds
  keyGenerator?: (ctx: HttpContext) => string
}

const store: Map<string, { count: number; resetAt: number }> = new Map()

export default class RateLimitMiddleware {
  private max: number
  private window: number
  private keyGenerator: (ctx: HttpContext) => string

  constructor(config?: RateLimitConfig) {
    this.max = config?.max ?? 100
    this.window = config?.window ?? 60
    this.keyGenerator = config?.keyGenerator ?? ((ctx) => ctx.request.ip())
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const key = this.keyGenerator(ctx)
    const now = Date.now()
    let entry = store.get(key)

    // Evict stale entries periodically
    if (store.size > 10000) {
      for (const [k, v] of store) {
        if (v.resetAt < now) store.delete(k)
      }
    }

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + this.window * 1000 }
      store.set(key, entry)
    }

    entry.count++

    const remaining = Math.max(0, this.max - entry.count)
    const resetInSeconds = Math.ceil((entry.resetAt - now) / 1000)

    ctx.response.header('x-ratelimit-limit', String(this.max))
    ctx.response.header('x-ratelimit-remaining', String(remaining))
    ctx.response.header('x-ratelimit-reset', String(resetInSeconds))

    if (entry.count > this.max) {
      ctx.response.header('retry-after', String(resetInSeconds))
      ctx.response.status(429).json({
        error: {
          code: 'E_TOO_MANY_REQUESTS',
          message: 'Too many requests',
          retryAfter: resetInSeconds,
        },
      })
      return
    }

    await next()
  }
}

/**
 * Shield middleware — combines multiple security protections in one.
 *
 * - CSRF token validation for state-changing methods
 * - Parameter pollution protection
 * - Path traversal blocking
 * - Request ID propagation
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import type { HttpContext } from '../http/HttpContext.js'

export interface ShieldConfig {
  csrf?: {
    enabled?: boolean
    methods?: string[]
    cookieName?: string
    headerName?: string
    secret?: string
  }
  paramPollution?: boolean
  pathTraversal?: boolean
  requestId?: boolean
}

const DEFAULTS: ShieldConfig = {
  csrf: {
    enabled: false,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    cookieName: '_csrf',
    headerName: 'x-csrf-token',
  },
  paramPollution: true,
  pathTraversal: true,
  requestId: true,
}

export default class ShieldMiddleware {
  private config: ShieldConfig

  constructor(config?: ShieldConfig) {
    this.config = {
      csrf: { ...DEFAULTS.csrf, ...config?.csrf },
      paramPollution: config?.paramPollution ?? DEFAULTS.paramPollution,
      pathTraversal: config?.pathTraversal ?? DEFAULTS.pathTraversal,
      requestId: config?.requestId ?? DEFAULTS.requestId,
    }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    // Request ID propagation
    if (this.config.requestId) {
      ctx.response.header('x-request-id', ctx.id)
    }

    // Path traversal protection
    if (this.config.pathTraversal) {
      const path = ctx.request.path()
      if (path.includes('..') || path.includes('%2e%2e') || path.includes('%252e')) {
        ctx.response.status(400).json({
          error: { code: 'E_PATH_TRAVERSAL', message: 'Path traversal detected' },
        })
        return
      }
    }

    // Parameter pollution: reject duplicate query params that shouldn't be arrays
    if (this.config.paramPollution) {
      const rawQuery = ctx.request.url(true).split('?')[1] ?? ''
      const seen = new Set<string>()
      for (const pair of rawQuery.split('&')) {
        const key = pair.split('=')[0]
        if (!key) continue
        if (key.endsWith('[]')) continue // arrays are expected
        if (seen.has(key)) {
          ctx.response.status(400).json({
            error: { code: 'E_PARAMETER_POLLUTION', message: `Duplicate parameter: ${key}` },
          })
          return
        }
        seen.add(key)
      }
    }

    // CSRF validation
    const csrfConfig = this.config.csrf
    if (csrfConfig?.enabled) {
      const method = ctx.request.method()
      if (csrfConfig.methods?.includes(method)) {
        const cookieToken = parseCookie(ctx.request.header('cookie') ?? '', csrfConfig.cookieName!)
        const headerToken = ctx.request.header(csrfConfig.headerName!) ?? ctx.request.input<string>('_csrf')

        if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
          ctx.response.status(403).json({
            error: { code: 'E_BAD_CSRF_TOKEN', message: 'Invalid CSRF token' },
          })
          return
        }
      }

      // Generate CSRF token for GET requests
      if (method === 'GET' || method === 'HEAD') {
        const token = randomBytes(32).toString('base64url')
        ctx.response.cookie(csrfConfig.cookieName!, token, {
          httpOnly: false, // JS needs to read it
          sameSite: 'lax',
          path: '/',
        })
        ctx.store.set('csrfToken', token)
      }
    }

    await next()
  }
}

function parseCookie(header: string, name: string): string | null {
  for (const pair of header.split(';')) {
    const [k, v] = pair.trim().split('=')
    if (k === name && v) return decodeURIComponent(v)
  }
  return null
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

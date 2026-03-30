/**
 * Health Check — built-in /health endpoint compatible with Kubernetes liveness/readiness probes.
 *
 * @implements FR81
 */

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error'
  uptime: number
  timestamp: string
  checks: HealthCheckResult[]
}

export interface HealthCheckResult {
  name: string
  status: 'ok' | 'warn' | 'error'
  message?: string
  latency?: number
}

export type HealthChecker = () => Promise<HealthCheckResult> | HealthCheckResult

/** Default per-checker timeout in ms. */
const DEFAULT_CHECK_TIMEOUT = 5000

/**
 * Manages health check registrations and produces aggregated status.
 */
export class HealthCheck {
  private checkers: Map<string, HealthChecker> = new Map()
  private startTime = Date.now()
  private checkTimeout: number

  constructor(options?: { checkTimeout?: number }) {
    this.checkTimeout = options?.checkTimeout ?? DEFAULT_CHECK_TIMEOUT
  }

  /** Register a health checker. */
  register(name: string, checker: HealthChecker): void {
    this.checkers.set(name, checker)
  }

  /** Run all health checks and return aggregated status. */
  async check(): Promise<HealthStatus> {
    const checks: HealthCheckResult[] = []

    for (const [name, checker] of this.checkers) {
      const start = Date.now()
      try {
        const result = await Promise.race([
          Promise.resolve(checker()),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Health check '${name}' timed out after ${this.checkTimeout}ms`)), this.checkTimeout),
          ),
        ])
        // Enforce authoritative name from registration key
        result.name = name
        result.latency = Date.now() - start
        checks.push(result)
      } catch (err) {
        checks.push({
          name,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          latency: Date.now() - start,
        })
      }
    }

    const hasError = checks.some((c) => c.status === 'error')
    const hasWarn = checks.some((c) => c.status === 'warn')

    return {
      status: hasError ? 'error' : hasWarn ? 'degraded' : 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    }
  }

  /** Create the /health route handler. Returns 200 for ok, 503 for degraded/error. */
  handler(): (ctx: { response: { status: number; headers: Record<string, string>; body: string } }) => Promise<void> {
    return async (ctx) => {
      const health = await this.check()
      ctx.response.status = health.status === 'ok' ? 200 : 503
      ctx.response.headers['content-type'] = 'application/json'
      ctx.response.body = JSON.stringify(health)
    }
  }
}

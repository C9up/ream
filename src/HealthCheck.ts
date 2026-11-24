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
 * What a check that threw reports. The thrown message is not passed on: a
 * driver's error names internal hosts and ports (`connect ECONNREFUSED
 * 10.0.3.17:5432`) or the database user, and this status is what a `/health`
 * route answers. The real error goes to `onError`.
 */
const CHECK_FAILED_MESSAGE = 'Health check failed'

export interface HealthCheckOptions {
  /** Per-checker timeout in ms. Default 5000. */
  checkTimeout?: number
  /**
   * Receives the error of a check that threw or timed out, which the status
   * reports only as a fixed message. Default: written to stderr.
   */
  onError?: (name: string, error: unknown) => void
}

function logCheckError(name: string, error: unknown): void {
  process.stderr.write(`[health] check '${name}' failed: ${String(error)}\n`)
}

/** The timeout of one check: its message is ours, and safe to answer. */
class CheckTimeout extends Error {}

/**
 * Manages health check registrations and produces aggregated status.
 *
 * A check that throws is reported as `Health check failed`; its error goes to
 * `onError`. A check that returns `{ status: 'error', message }` keeps its
 * own message: the application chose it.
 */
export class HealthCheck {
  readonly #checkers: Map<string, HealthChecker> = new Map()
  readonly #startTime = Date.now()
  readonly #checkTimeout: number
  readonly #onError: (name: string, error: unknown) => void

  constructor(options?: HealthCheckOptions) {
    this.#checkTimeout = options?.checkTimeout ?? DEFAULT_CHECK_TIMEOUT
    this.#onError = options?.onError ?? logCheckError
  }

  /** Register a health checker. */
  register(name: string, checker: HealthChecker): void {
    this.#checkers.set(name, checker)
  }

  /**
   * Run all health checks and return aggregated status.
   *
   * The checks run concurrently, as AdonisJS's `HealthChecks.run()` does, so N
   * slow checks cost one timeout rather than N; results keep registration
   * order. Each timeout timer is cleared as soon as its check settles — a
   * timer left armed kept the process alive for `checkTimeout` after every
   * probe and delayed a graceful shutdown.
   */
  async check(): Promise<HealthStatus> {
    const checks = await Promise.all(
      [...this.#checkers].map(([name, checker]) => this.#runOne(name, checker)),
    )
    const hasError = checks.some((c) => c.status === 'error')
    const hasWarn = checks.some((c) => c.status === 'warn')

    return {
      status: hasError ? 'error' : hasWarn ? 'degraded' : 'ok',
      uptime: Math.floor((Date.now() - this.#startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    }
  }

  async #runOne(name: string, checker: HealthChecker): Promise<HealthCheckResult> {
    const start = Date.now()
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        Promise.resolve().then(checker),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CheckTimeout(`Health check timed out after ${this.#checkTimeout}ms`)),
            this.#checkTimeout,
          )
        }),
      ])
      // Enforce authoritative name from registration key
      result.name = name
      result.latency = Date.now() - start
      return result
    } catch (err) {
      this.#onError(name, err)
      return {
        name,
        status: 'error',
        message: err instanceof CheckTimeout ? err.message : CHECK_FAILED_MESSAGE,
        latency: Date.now() - start,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Create the /health route handler. Returns 200 for ok, 503 otherwise.
   *
   * The parameter is the narrowest shape a real `HttpContext` satisfies, so
   * this can be mounted straight on a route. It used to assign
   * `ctx.response.status` and `ctx.response.body` as PROPERTIES, which no Ream
   * response has ever had — mounted for real it would have answered an empty
   * 200 to every probe, marking a dead app healthy. Its only test built a fake
   * context in that invented shape, so nothing caught it.
   */
  handler(): (ctx: {
    response: {
      status(code: number): unknown
      header(key: string, value: string): unknown
      json(body: unknown): unknown
    }
  }) => Promise<void> {
    return async (ctx) => {
      const health = await this.check()
      ctx.response.status(health.status === 'ok' ? 200 : 503)
      ctx.response.header('content-type', 'application/json')
      ctx.response.json(health)
    }
  }
}

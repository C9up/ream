/**
 * Health-check contracts, mirroring `@adonisjs/core/health`.
 */

/** The outcome of running one check. */
export type HealthCheckResult = {
  /** A summary of the check result. */
  message: string
  /** The status of the check. */
  status: 'ok' | 'warning' | 'error'
  /** When this check finished. */
  finishedAt: Date
  /** Free-form data the check wants to expose alongside its verdict. */
  meta?: Record<string, unknown>
}

/** The report produced by running every registered check. */
export type HealthCheckReport = {
  /** False as soon as one check reports `error`. A warning stays healthy. */
  isHealthy: boolean
  /** `error` beats `warning` beats `ok`. */
  status: 'ok' | 'warning' | 'error'
  /** When the whole report was computed. */
  finishedAt: Date
  /** Identifying data for the process that produced the report. */
  debugInfo: {
    pid: number
    ppid?: number
    /** Seconds the process has been running. */
    uptime: number
    version: string
    platform: string
  }
  /** Each check's result, plus whether it came from the cache. */
  checks: ({ isCached: boolean; name: string } & HealthCheckResult)[]
}

/** What every check must implement. */
export interface HealthCheckContract {
  /** A unique name for the check. */
  name: string
  /** Seconds to reuse a previous result for. Undefined means never cache. */
  cacheDuration?: number
  /** Perform the check. */
  run(): Promise<HealthCheckResult>
}

/** What a tracing subscriber receives. */
export type HealthCheckTracingData = {
  check: HealthCheckContract
}

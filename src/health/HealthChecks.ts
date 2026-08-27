import { debuglog } from 'node:util'
import { healthCheck } from './tracing.js'
import type { HealthCheckContract, HealthCheckReport } from './types.js'

const debug = debuglog('ream:health')

/**
 * Runs the registered checks and aggregates them into one report
 * (AdonisJS `HealthChecks`).
 */
export class HealthChecks {
  #checks: HealthCheckContract[] = []
  #cachedResults = new Map<string, Awaited<ReturnType<HealthCheckContract['run']>>>()

  /** Replace the registered checks. */
  register(checks: HealthCheckContract[]): this {
    this.#checks = checks
    return this
  }

  /** Add to the registered checks. */
  append(checks: HealthCheckContract[]): this {
    this.#checks = this.#checks.concat(checks)
    return this
  }

  #getDebugInfo(): HealthCheckReport['debugInfo'] {
    return {
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      uptime: process.uptime(),
      version: process.version,
    }
  }

  async #runCheck(check: HealthCheckContract): Promise<HealthCheckReport['checks'][number]> {
    if (check.cacheDuration) {
      const cached = this.#cachedResults.get(check.name)
      const cacheMilliseconds = Math.floor(check.cacheDuration * 1000)
      if (cached && Date.now() < cached.finishedAt.getTime() + cacheMilliseconds) {
        debug('returning cached results for "%s" check', check.name)
        return { name: check.name, isCached: true, ...cached }
      }
    }

    const result = await healthCheck.tracePromise(
      check.run,
      healthCheck.hasSubscribers ? { check } : undefined,
      check,
    )
    debug('executed "%s" check', check.name)
    if (check.cacheDuration) this.#cachedResults.set(check.name, result)
    return { name: check.name, isCached: false, ...result }
  }

  /** Run every check concurrently and aggregate the verdicts. */
  async run(): Promise<HealthCheckReport> {
    let isHealthy = true
    let status: HealthCheckReport['status'] = 'ok'

    const checks = await Promise.all(
      this.#checks.map(async (check) => {
        const result = await this.#runCheck(check)
        if (result.status === 'error') {
          status = 'error'
          isHealthy = false
        } else if (status === 'ok' && result.status === 'warning') {
          status = 'warning'
        }
        return result
      }),
    )

    return {
      isHealthy,
      status,
      finishedAt: new Date(),
      debugInfo: this.#getDebugInfo(),
      checks,
    }
  }
}

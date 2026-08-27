import { durationToSeconds } from '../helpers/duration.js'
import type { HealthCheckContract, HealthCheckResult } from './types.js'

/**
 * The base every check extends (AdonisJS `BaseCheck`).
 */
export abstract class BaseCheck implements HealthCheckContract {
  abstract name: string
  /** Seconds to reuse a previous result for. */
  cacheDuration?: number

  /** Rename the check, so two instances of one check stay distinguishable. */
  as(name: string): this {
    this.name = name
    return this
  }

  /**
   * Reuse this check's result for the given duration — `60`, `'1 minute'`,
   * `'30s'`. An expensive check (a remote ping, a disk stat) should not run on
   * every probe.
   */
  cacheFor(duration: string | number): this {
    this.cacheDuration =
      typeof duration === 'number' ? duration : durationToSeconds(duration, 'a health check cache')
    return this
  }

  abstract run(): Promise<HealthCheckResult>
}

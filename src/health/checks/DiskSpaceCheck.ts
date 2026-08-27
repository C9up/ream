import { statfs } from 'node:fs/promises'
import { BaseCheck } from '../BaseCheck.js'
import { Result } from '../Result.js'
import type { HealthCheckResult } from '../types.js'

/**
 * Watches how full the disk is (AdonisJS `DiskSpaceCheck`).
 *
 * NAMED DEVIATION — upstream depends on the `check-disk-space` package, which
 * shells out to `df` on POSIX and `wmic` on Windows. Ream reads Node's own
 * `fs.statfs` instead: no dependency, no subprocess, and the same two numbers.
 * `bavail` rather than `bfree` is deliberate — it is the space actually
 * available to this process, which is what `df` reports and what an operator
 * means by "free".
 */
export class DiskSpaceCheck extends BaseCheck {
  #warnThreshold = 75
  #failThreshold = 80
  #computeFn: () => Promise<{ free: number; size: number }> = async () => {
    const stats = await statfs(this.diskPath)
    return { free: Number(stats.bavail) * stats.bsize, size: Number(stats.blocks) * stats.bsize }
  }

  name = 'Disk space check'
  /** The mount point to measure. */
  diskPath = process.platform === 'win32' ? 'C:\\' : '/'

  /** Warn once this percentage of the disk is used. */
  warnWhenExceeds(valueInPercentage: number): this {
    this.#warnThreshold = valueInPercentage
    return this
  }

  /** Fail once this percentage of the disk is used. */
  failWhenExceeds(valueInPercentage: number): this {
    this.#failThreshold = valueInPercentage
    return this
  }

  /** Replace how the reading is taken, so a test can drive the thresholds. */
  compute(callback: () => Promise<{ free: number; size: number }>): this {
    this.#computeFn = callback
    return this
  }

  async run(): Promise<HealthCheckResult> {
    const { free, size } = await this.#computeFn()
    const usedPercentage = Math.floor(((size - free) / size) * 100)
    const metaData = {
      sizeInPercentage: {
        used: usedPercentage,
        failureThreshold: this.#failThreshold,
        warningThreshold: this.#warnThreshold,
      },
    }

    if (usedPercentage >= this.#failThreshold) {
      return Result.failed(
        `Disk usage is ${usedPercentage}%, which is above the threshold of ${this.#failThreshold}%`,
      ).mergeMetaData(metaData)
    }
    if (usedPercentage >= this.#warnThreshold) {
      return Result.warning(
        `Disk usage is ${usedPercentage}%, which is above the threshold of ${this.#warnThreshold}%`,
      ).mergeMetaData(metaData)
    }
    return Result.ok('Disk usage is under defined thresholds').mergeMetaData(metaData)
  }
}

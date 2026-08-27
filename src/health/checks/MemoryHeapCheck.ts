import v8 from 'node:v8'
import { BaseCheck } from '../BaseCheck.js'
import type { HealthCheckResult } from '../types.js'
import { assertPercentage, parseByteThreshold, runMemoryCheck } from './memory.js'

/**
 * Watches the V8 heap (AdonisJS `MemoryHeapCheck`).
 */
export class MemoryHeapCheck extends BaseCheck {
  #warnThresholdBytes: number | null = 250 * 1024 ** 2
  #failThresholdBytes: number | null = 300 * 1024 ** 2
  #warnThresholdPercentage: number | null = null
  #failThresholdPercentage: number | null = null
  #computeFn: () => NodeJS.MemoryUsage = () => process.memoryUsage()

  name = 'Memory heap check'

  /** Warn above this size — `'300 mb'` or a byte count. Clears any percentage. */
  warnWhenExceeds(value: string | number): this {
    this.#warnThresholdBytes = parseByteThreshold(value, 'warnWhenExceeds')
    this.#warnThresholdPercentage = null
    return this
  }

  /** Fail above this size. Clears any percentage. */
  failWhenExceeds(value: string | number): this {
    this.#failThresholdBytes = parseByteThreshold(value, 'failWhenExceeds')
    this.#failThresholdPercentage = null
    return this
  }

  /** Warn above this share of the heap ceiling. Clears any byte threshold. */
  warnWhenExceedsPercentage(valueInPercentage: number): this {
    assertPercentage(valueInPercentage, 'Warn')
    this.#warnThresholdPercentage = valueInPercentage
    this.#warnThresholdBytes = null
    return this
  }

  /** Fail above this share of the heap ceiling. Clears any byte threshold. */
  failWhenExceedsPercentage(valueInPercentage: number): this {
    assertPercentage(valueInPercentage, 'Fail')
    this.#failThresholdPercentage = valueInPercentage
    this.#failThresholdBytes = null
    return this
  }

  /** Replace how the reading is taken, so a test can drive the thresholds. */
  compute(callback: () => NodeJS.MemoryUsage): this {
    this.#computeFn = callback
    return this
  }

  async run(): Promise<HealthCheckResult> {
    const { heapUsed } = this.#computeFn()
    return runMemoryCheck(
      heapUsed,
      {
        warnBytes: this.#warnThresholdBytes,
        failBytes: this.#failThresholdBytes,
        warnPercentage: this.#warnThresholdPercentage,
        failPercentage: this.#failThresholdPercentage,
      },
      { subject: 'Heap', ceilingKey: 'heapInBytes', ceilingName: 'maxHeapSize' },
      () => v8.getHeapStatistics().heap_size_limit,
    )
  }
}

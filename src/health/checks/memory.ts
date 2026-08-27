import bytes from '../../helpers/bytes.js'
import { Result } from '../Result.js'
import type { HealthCheckResult } from '../types.js'

/**
 * The shared body of the two memory checks.
 *
 * Upstream spells this logic out twice, once in `MemoryRSSCheck` and once in
 * `MemoryHeapCheck`; only the reading, the ceiling it is compared against, and
 * two strings differ. The public surface of both classes is unchanged — this is
 * an internal detail, not a deviation.
 */
export type MemoryThresholds = {
  warnBytes: number | null
  failBytes: number | null
  warnPercentage: number | null
  failPercentage: number | null
}

export function runMemoryCheck(
  used: number,
  thresholds: MemoryThresholds,
  labels: { subject: string; ceilingKey: string; ceilingName: string },
  readCeiling: () => number,
): HealthCheckResult {
  const compareAsPercentage =
    thresholds.warnPercentage !== null || thresholds.failPercentage !== null

  let warnThreshold: number
  let failThreshold: number
  let valueToCompare: number
  let ceiling: number | null = null
  let usedPercentage: number | null = null

  if (compareAsPercentage) {
    ceiling = readCeiling()
    if (ceiling === 0) {
      return Result.failed(`Cannot determine ${labels.ceilingName} (0 bytes).`).mergeMetaData({
        [labels.ceilingKey]: { used, [labels.ceilingName]: ceiling },
      })
    }
    usedPercentage = Math.floor((used / ceiling) * 100)
    valueToCompare = usedPercentage

    if (thresholds.warnPercentage !== null) warnThreshold = thresholds.warnPercentage
    else if (thresholds.warnBytes !== null)
      warnThreshold = Math.floor((thresholds.warnBytes / ceiling) * 100)
    else return Result.failed('Warning threshold for percentage comparison is missing.')

    if (thresholds.failPercentage !== null) failThreshold = thresholds.failPercentage
    else if (thresholds.failBytes !== null)
      failThreshold = Math.floor((thresholds.failBytes / ceiling) * 100)
    else return Result.failed('Failure threshold for percentage comparison is missing.')
  } else {
    valueToCompare = used
    if (thresholds.warnBytes === null) return Result.failed('Warning threshold (bytes) is missing.')
    warnThreshold = thresholds.warnBytes
    if (thresholds.failBytes === null) return Result.failed('Failure threshold (bytes) is missing.')
    failThreshold = thresholds.failBytes
  }

  const metaData: Record<string, unknown> = {}
  if (compareAsPercentage) {
    metaData.sizeInPercentage = {
      used: usedPercentage,
      failureThreshold: failThreshold,
      warningThreshold: warnThreshold,
    }
    if (ceiling !== null) {
      metaData[labels.ceilingKey] = {
        used,
        [labels.ceilingName]: ceiling,
        failureThreshold: Math.floor((failThreshold / 100) * ceiling),
        warningThreshold: Math.floor((warnThreshold / 100) * ceiling),
      }
    }
  } else {
    metaData.memoryInBytes = {
      used,
      failureThreshold: failThreshold,
      warningThreshold: warnThreshold,
    }
  }

  const show = (value: number, threshold: number) =>
    compareAsPercentage
      ? { used: `${value}%`, limit: `${threshold}%` }
      : { used: bytes.format(used), limit: bytes.format(threshold) }

  if (valueToCompare >= failThreshold) {
    const { used: u, limit } = show(valueToCompare, failThreshold)
    return Result.failed(
      `${labels.subject} usage is ${u}, which is above the threshold of ${limit}`,
    ).mergeMetaData(metaData)
  }
  if (valueToCompare >= warnThreshold) {
    const { used: u, limit } = show(valueToCompare, warnThreshold)
    return Result.warning(
      `${labels.subject} usage is ${u}, which is above the threshold of ${limit}`,
    ).mergeMetaData(metaData)
  }
  return Result.ok(`${labels.subject} usage is under defined thresholds`).mergeMetaData(metaData)
}

/** The threshold setters both memory checks expose, shared verbatim. */
export function parseByteThreshold(value: string | number, method: string): number {
  const parsed = bytes.parse(value)
  if (parsed === null) throw new Error(`Invalid byte value for ${method}: ${value}`)
  return parsed
}

export function assertPercentage(value: number, label: string): void {
  if (value < 0 || value > 100)
    throw new Error(`${label} threshold percentage must be between 0 and 100.`)
}

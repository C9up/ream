import type { HealthCheckResult } from './types.js'

/**
 * A chainable builder for a check result (AdonisJS `Result`).
 */
export class Result implements HealthCheckResult {
  message: string
  status: HealthCheckResult['status']
  finishedAt: Date
  /** Free-form data attached to the result. */
  meta?: HealthCheckResult['meta']

  constructor(message: string, status: HealthCheckResult['status'], finishedAt: Date) {
    this.message = message
    this.status = status
    this.finishedAt = finishedAt
  }

  /** A passing result. */
  static ok(message: string): Result {
    return new Result(message, 'ok', new Date())
  }

  /** A failing result. Accepts a message, a message and an error, or an error. */
  static failed(message: string, error?: Error): Result
  static failed(error: Error): Result
  static failed(message: string | Error, error?: Error): Result {
    const result = new Result(
      typeof message === 'string' ? message : message.message,
      'error',
      new Date(),
    )
    if (error) result.setMetaData({ error })
    if (typeof message !== 'string') result.setMetaData({ error: message })
    return result
  }

  /** A result that is not yet failing but wants attention. */
  static warning(message: string): Result {
    return new Result(message, 'warning', new Date())
  }

  /** Override when the check finished. */
  setFinishedAt(finishedAt: Date): this {
    this.finishedAt = finishedAt
    return this
  }

  /** Replace the meta-data wholesale. */
  setMetaData(metaData: Record<string, unknown>): this {
    this.meta = metaData
    return this
  }

  /** Shallow-merge into the existing meta-data. */
  mergeMetaData(metaData: Record<string, unknown>): this {
    this.meta = { ...this.meta, ...metaData }
    return this
  }

  toJSON(): HealthCheckResult {
    return {
      finishedAt: this.finishedAt,
      message: this.message,
      status: this.status,
      ...(this.meta ? { meta: this.meta } : {}),
    }
  }
}

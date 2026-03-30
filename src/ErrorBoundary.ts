/**
 * Root Error Boundary — all errors flow through the bus.
 *
 * @implements Story 4.8
 *
 * Catches all uncaught errors and emits them as Pulsar events:
 * - service.error — handler/business logic failures
 * - security.rejected — Blackhole rejections
 * - system.error — infrastructure failures (NAPI, DB)
 * - system.fatal — unrecoverable process-level errors
 */

export type ErrorSeverity = 'info' | 'warning' | 'critical'

export interface ErrorEvent {
  type: 'service.error' | 'security.rejected' | 'system.error' | 'system.fatal'
  source: string
  message: string
  severity: ErrorSeverity
  correlationId?: string
  originalError?: string
  timestamp: string
}

export type ErrorEmitter = (event: ErrorEvent) => void

/**
 * Root Error Boundary.
 *
 * Wraps the entire application lifecycle:
 * - Catches unhandledRejection and uncaughtException
 * - Emits structured error events via the provided emitter (Pulsar bus)
 * - In dev mode, also logs to console
 */
export class ErrorBoundary {
  private emitter: ErrorEmitter
  private devMode: boolean
  private installed = false
  private rejectionHandler?: (reason: unknown) => void
  private exceptionHandler?: (error: Error) => void

  constructor(emitter: ErrorEmitter, devMode = false) {
    this.emitter = emitter
    this.devMode = devMode
  }

  /** Install global error handlers. */
  install(): void {
    if (this.installed) return

    this.rejectionHandler = (reason) => {
      this.handleError('system.fatal', 'UnhandledRejection', reason)
    }

    this.exceptionHandler = (error) => {
      this.handleError('system.fatal', 'UncaughtException', error)
      // Node.js is in undefined state after uncaughtException — must exit
      process.exit(1)
    }

    process.on('unhandledRejection', this.rejectionHandler)
    process.on('uncaughtException', this.exceptionHandler)

    this.installed = true
  }

  /** Uninstall global error handlers (for testing). Only removes OUR handlers. */
  uninstall(): void {
    if (this.rejectionHandler) {
      process.removeListener('unhandledRejection', this.rejectionHandler)
    }
    if (this.exceptionHandler) {
      process.removeListener('uncaughtException', this.exceptionHandler)
    }
    this.rejectionHandler = undefined
    this.exceptionHandler = undefined
    this.installed = false
  }

  /** Emit a service error (handler failure). */
  serviceError(source: string, error: unknown, correlationId?: string): void {
    this.handleError('service.error', source, error, correlationId)
  }

  /** Emit a security rejection. */
  securityRejected(source: string, reason: string, correlationId?: string): void {
    const event: ErrorEvent = {
      type: 'security.rejected',
      source,
      message: reason,
      severity: 'warning',
      correlationId,
      timestamp: new Date().toISOString(),
    }
    this.emit(event)
  }

  /** Emit a system error (infrastructure failure). */
  systemError(source: string, error: unknown, correlationId?: string): void {
    this.handleError('system.error', source, error, correlationId)
  }

  private handleError(
    type: ErrorEvent['type'],
    source: string,
    error: unknown,
    correlationId?: string,
  ): void {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined

    const event: ErrorEvent = {
      type,
      source,
      message,
      severity: type === 'system.fatal' ? 'critical' :
        type === 'system.error' ? 'critical' : 'warning',
      correlationId,
      originalError: stack ?? message,
      timestamp: new Date().toISOString(),
    }

    this.emit(event)
  }

  private emit(event: ErrorEvent): void {
    try {
      this.emitter(event)
    } catch {
      // If the emitter itself fails, log to stderr as last resort
      process.stderr.write(`[ErrorBoundary] Failed to emit: ${JSON.stringify(event)}\n`)
    }

    if (this.devMode) {
      const prefix = event.type === 'system.fatal' ? '✗ FATAL' :
        event.type === 'system.error' ? '✗ ERROR' :
        event.type === 'security.rejected' ? '⚠ SECURITY' : '✗ SERVICE'
      process.stderr.write(`${prefix} [${event.source}] ${event.message}\n`)
    }
  }
}

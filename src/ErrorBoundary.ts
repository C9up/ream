/**
 * Root Error Boundary — all errors flow through the bus.
 *
 * @implements Story 4.8
 *
 * Catches all uncaught errors and emits them as event-bus events:
 * - service.error — handler/business logic failures
 * - security.rejected — Blackhole rejections
 * - system.error — infrastructure failures (NAPI, DB)
 * - system.fatal — unrecoverable process-level errors
 */

import { currentNodeEnv } from './env/nodeEnv.js'

export type ErrorSeverity = 'info' | 'warning' | 'critical'

export interface ErrorEvent {
  type: 'service.error' | 'security.rejected' | 'system.error' | 'system.fatal' | 'system.info'
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
 * - Emits structured error events via the provided emitter (event bus)
 * - In dev mode, also logs to console
 */
export class ErrorBoundary {
  #emitter: ErrorEmitter
  #devMode: boolean
  #installed = false
  #rejectionHandler?: (reason: unknown) => void
  #exceptionHandler?: (error: Error) => void

  constructor(emitter: ErrorEmitter, devMode = false) {
    this.#emitter = emitter
    this.#devMode = devMode
  }

  /** Install global error handlers. */
  install(): void {
    if (this.#installed) return

    // Skip global install under vitest — each test instantiates its own
    // Ignitor and rarely calls `.stop()`, so per-test listeners pile up on
    // the singleton `process` and trigger Node's MaxListenersExceeded
    // warning. Production code-paths still get coverage via direct
    // `handleError`/`serviceError` calls; only the Node-level signal
    // bridging is suppressed.
    if (process.env.VITEST === 'true' || currentNodeEnv() === 'test') {
      this.#installed = true
      return
    }

    this.#rejectionHandler = (reason) => {
      this.#handleError('system.fatal', 'UnhandledRejection', reason)
    }

    this.#exceptionHandler = (error) => {
      this.#handleError('system.fatal', 'UncaughtException', error)
      // Node.js is in undefined state after uncaughtException — must exit
      process.exit(1)
    }

    process.on('unhandledRejection', this.#rejectionHandler)
    process.on('uncaughtException', this.#exceptionHandler)

    this.#installed = true
  }

  /** Uninstall global error handlers (for testing). Only removes OUR handlers. */
  uninstall(): void {
    if (this.#rejectionHandler) {
      process.removeListener('unhandledRejection', this.#rejectionHandler)
    }
    if (this.#exceptionHandler) {
      process.removeListener('uncaughtException', this.#exceptionHandler)
    }
    this.#rejectionHandler = undefined
    this.#exceptionHandler = undefined
    this.#installed = false
  }

  /** Emit a service error (handler failure). */
  serviceError(source: string, error: unknown, correlationId?: string): void {
    this.#handleError('service.error', source, error, correlationId)
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
    this.#emit(event)
  }

  /** Emit a system error (infrastructure failure). */
  systemError(source: string, error: unknown, correlationId?: string): void {
    this.#handleError('system.error', source, error, correlationId)
  }

  #handleError(
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
      severity:
        type === 'system.fatal' ? 'critical' : type === 'system.error' ? 'critical' : 'warning',
      correlationId,
      originalError: stack ?? message,
      timestamp: new Date().toISOString(),
    }

    this.#emit(event)
  }

  #emit(event: ErrorEvent): void {
    try {
      this.#emitter(event)
    } catch {
      // If the emitter itself fails, log to stderr as last resort
      process.stderr.write(`[ErrorBoundary] Failed to emit: ${JSON.stringify(event)}\n`)
    }

    // A fatal always reaches stderr, dev or not.
    //
    // Installing this boundary REPLACES Node's own handling of an unhandled
    // rejection, which prints the reason and exits. An app that registered no
    // error listener would otherwise swallow every one of them silently — the
    // boundary would turn each forgotten `await` from a loud crash into
    // nothing at all, which is the opposite of what it is for. A duplicated
    // line when a listener also logs it is a much smaller price.
    if (this.#devMode || event.type === 'system.fatal') {
      const prefix =
        event.type === 'system.fatal'
          ? '✗ FATAL'
          : event.type === 'system.error'
            ? '✗ ERROR'
            : event.type === 'security.rejected'
              ? '⚠ SECURITY'
              : '✗ SERVICE'
      process.stderr.write(`${prefix} [${event.source}] ${event.message}\n`)
      // The stack is the only part that says WHERE the rejection came from.
      if (event.type === 'system.fatal' && event.originalError !== undefined) {
        process.stderr.write(`${event.originalError}\n`)
      }
    }
  }
}

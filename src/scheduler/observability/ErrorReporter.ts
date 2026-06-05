/**
 * Callback invoked when a scheduled task throws. Typically bridges
 * to `ErrorBoundary.serviceError` — but the scheduler does not
 * import `ErrorBoundary` directly; the user wires the adapter
 * per the "agnostic per package" rule.
 *
 * The scheduler wraps the call in its own `try/catch`, so an
 * `ErrorReporter` that itself throws cannot crash the Rust ticker.
 *
 * @implements Story 28.4
 */

export type ErrorReporter = (err: unknown, context: { taskName: string }) => void

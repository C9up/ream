/**
 * Destination for scheduler task-invocation events.
 *
 * This interface is intentionally minimal so users can adapt to any
 * event bus (the bus, a raw `EventEmitter`, a structured logger). The
 * scheduler does NOT import the event bus directly — writing the
 * bridge is the user's responsibility per the project's "agnostic
 * per package" rule.
 *
 * The scheduler treats `emit` as fire-and-forget: it does not await
 * the return value, and any sync throw is caught at the call site so
 * a buggy adapter cannot crash the Rust ticker.
 *
 * @implements Story 28.4
 */

import type { ScheduleEvent } from './ScheduleEvent.js'

export interface ScheduleEventSink {
  emit(event: ScheduleEvent): void | Promise<void>
}

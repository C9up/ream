/**
 * What the profiler watches.
 *
 * Each one is independent and may be replaced: the database collector is the
 * interesting case, because the data does not come from the request at all. It
 * comes from `db:query` events the data layer emits with no idea which request
 * caused them, and the profiler's async store is what puts each one back where
 * it belongs.
 *
 * NO import of atlas. The collector listens on the application's emitter for
 * `db:query`, which is the shape atlas documents for bridging its own registry
 * (`onDbQuery((event) => emitter.emit('db:query', event))`). A project on
 * another data layer emits the same event and gets the same panel.
 */

import type { CollectedData, ProfilerCollector } from './types.js'

/** One SQL statement, as the panel shows it. */
export interface RecordedQuery {
  sql: string
  bindings: readonly unknown[]
  /** Milliseconds. */
  duration: number
  connection?: string
  model?: string
  method?: string
  inTransaction?: boolean
  /** The message, when the statement threw. */
  error?: string
}

/** What the emitter must give this collector. Structural: no package imported. */
export interface QueryEventSource {
  on(event: string, listener: (payload: unknown) => void): unknown
}

/**
 * How many statements one request may record.
 *
 * A runaway loop issuing ten thousand queries is exactly the bug this panel
 * exists to show, and keeping all ten thousand would take the dev server down
 * with it. The count stays true past the cap; the list stops.
 */
const QUERY_CAP = 500

export function databaseCollector(
  events: QueryEventSource,
  read: () => QueryBag | undefined,
): ProfilerCollector<QueryBag> {
  // Subscribed once, at construction: a listener added per request would leak
  // one per request, and removing it on the way out would miss a query still
  // in flight.
  events.on('db:query', (payload) => {
    const bag = read()
    if (bag === undefined) return
    bag.total += 1
    bag.duration += durationOf(payload)
    if (bag.queries.length < QUERY_CAP) bag.queries.push(toQuery(payload))
  })

  return {
    name: 'database',
    badge: (data) => {
      const total = typeof data.total === 'number' ? data.total : 0
      const duration = typeof data.duration === 'number' ? data.duration : 0
      return `${total} ${total === 1 ? 'query' : 'queries'} · ${round(duration)} ms`
    },
    start: () => ({ total: 0, duration: 0, queries: [] }),
    finish: (bag) =>
      bag === undefined
        ? { total: 0, duration: 0, queries: [], capped: false }
        : {
            total: bag.total,
            duration: round(bag.duration),
            queries: bag.queries,
            capped: bag.total > bag.queries.length,
          },
  }
}

export interface QueryBag {
  total: number
  duration: number
  queries: RecordedQuery[]
}

/** The request and what it answered. */
export function requestCollector(): ProfilerCollector<RequestBag> {
  return {
    name: 'request',
    badge: (data) => (typeof data.route === 'string' ? data.route : undefined),
    start: () => ({}),
    finish: (bag) => ({ ...(bag ?? {}) }),
  }
}

export interface RequestBag {
  route?: string
  controller?: string
  userId?: string
}

/**
 * What went wrong, if anything.
 *
 * The one panel worth opening by itself: an exception that reached the handler
 * is reported here so it shows up in the page rather than only in the terminal
 * someone may not be looking at.
 */
export function exceptionCollector(): ProfilerCollector<ExceptionBag> {
  return {
    name: 'exception',
    badge: (data) => (typeof data.message === 'string' ? 'error' : undefined),
    start: () => ({}),
    finish: (bag) => ({ ...(bag ?? {}) }),
  }
}

export interface ExceptionBag {
  name?: string
  message?: string
  stack?: string
  /** Where it was reported from, when the framework knows. */
  code?: string
}

/** Lines logged while the request ran. */
export function logCollector(): ProfilerCollector<LogBag> {
  return {
    name: 'logs',
    badge: (data) => {
      const lines = Array.isArray(data.lines) ? data.lines.length : 0
      return lines === 0 ? undefined : `${lines} ${lines === 1 ? 'log' : 'logs'}`
    },
    start: () => ({ lines: [] }),
    finish: (bag) => ({ lines: bag?.lines ?? [] }),
  }
}

export interface LogBag {
  lines: Array<{ level: string; message: string; time: number }>
}

/** Peak heap while the request ran, which is what a leak shows up in. */
export function memoryCollector(): ProfilerCollector<{ start: number }> {
  return {
    name: 'memory',
    badge: (data) => (typeof data.usedMb === 'number' ? `${data.usedMb.toFixed(1)} MB` : undefined),
    start: () => ({ start: process.memoryUsage().heapUsed }),
    finish: (bag) => {
      const used = process.memoryUsage().heapUsed
      return {
        usedMb: used / 1024 / 1024,
        deltaMb: bag === undefined ? 0 : (used - bag.start) / 1024 / 1024,
      }
    },
  }
}

function toQuery(payload: unknown): RecordedQuery {
  const event = asRecord(payload)
  return {
    sql: typeof event.sql === 'string' ? event.sql : String(event.sql ?? ''),
    bindings: Array.isArray(event.bindings) ? event.bindings : [],
    duration: durationOf(payload),
    ...pickString(event, 'connection'),
    ...pickString(event, 'model'),
    ...pickString(event, 'method'),
    ...(event.inTransaction === true ? { inTransaction: true } : {}),
    ...(event.error instanceof Error ? { error: event.error.message } : {}),
  }
}

function durationOf(payload: unknown): number {
  const value = asRecord(payload).duration
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function pickString(event: Record<string, unknown>, key: string): CollectedData {
  const value = event[key]
  return typeof value === 'string' && value !== '' ? { [key]: value } : {}
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

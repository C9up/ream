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
 *
 * Every entry is stamped with `at`, milliseconds since the request arrived, so
 * the bar can lay queries, log lines and events out on one timeline.
 */

import { isSecretKey, preview, REDACTED } from './preview.js'
import type { CollectedData, CollectionScope, ProfilerCollector } from './types.js'

/** One SQL statement, as the panel shows it. */
export interface RecordedQuery {
  sql: string
  bindings: readonly unknown[]
  /** Milliseconds. */
  duration: number
  /** When it started, milliseconds since the request arrived. */
  at: number
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
    const duration = durationOf(payload)
    bag.total += 1
    bag.duration += duration
    if (isFailed(payload)) bag.failed += 1
    if (bag.queries.length < QUERY_CAP) {
      // The event arrives when the statement ENDS: it started `duration` ago.
      bag.queries.push(toQuery(payload, Math.max(0, bag.scope.elapsed() - duration)))
    }
  })

  return {
    name: 'database',
    badge: (data) => {
      const total = typeof data.total === 'number' ? data.total : 0
      const duration = typeof data.duration === 'number' ? data.duration : 0
      return `${total} ${total === 1 ? 'query' : 'queries'} · ${round(duration)} ms`
    },
    start: (scope) => ({ scope, total: 0, failed: 0, duration: 0, queries: [] }),
    finish: (bag) =>
      bag === undefined
        ? { total: 0, failed: 0, duration: 0, queries: [], capped: false }
        : {
            total: bag.total,
            failed: bag.failed,
            duration: round(bag.duration),
            queries: bag.queries,
            capped: bag.total > bag.queries.length,
          },
  }
}

export interface QueryBag {
  scope: CollectionScope
  total: number
  failed: number
  duration: number
  queries: RecordedQuery[]
}

/**
 * The request and what it answered.
 *
 * Filled by the profiling middleware once the handler has run — routing, the
 * session and the user are only known then. Every value that came from the
 * client goes through {@link preview}, which caps it and hides secrets.
 */
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
  pattern?: string
  controller?: string
  userId?: string
  user?: unknown
  path?: string
  ip?: string
  requestId?: string
  ajax?: boolean
  params?: unknown
  query?: unknown
  body?: unknown
  headers?: unknown
  cookies?: string[]
  session?: unknown
  response?: { status: number; contentType?: string; headers: unknown }
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

/**
 * Lines logged while the request ran.
 *
 * Same arrangement as the database panel, and for the same reason: a logger
 * writes a line with no idea which request caused it. It comes off the
 * application's emitter as `log:line`, which is what `@c9up/spectrum` bridges
 * its own registry to (`onLog((entry) => emitter.emit('log:line', entry))`),
 * so a project on another logger emits the same event and gets the same panel.
 */
export function logCollector(events: LogEventSource, read: () => LogBag | undefined) {
  // Subscribed once, at construction, for the same reason as the queries: a
  // listener per request leaks one per request.
  events.on('log:line', (payload) => {
    const bag = read()
    if (bag === undefined) return
    const line = toLine(payload, bag.scope.elapsed())
    bag.total += 1
    if (line.level === 'error' || line.level === 'fatal') bag.errors += 1
    if (line.level === 'warn') bag.warnings += 1
    if (bag.lines.length < LINE_CAP) bag.lines.push(line)
  })

  return {
    name: 'logs',
    badge: (data) => {
      const total = typeof data.total === 'number' ? data.total : 0
      return total === 0 ? undefined : `${total} ${total === 1 ? 'log' : 'logs'}`
    },
    start: (scope) => ({ scope, total: 0, errors: 0, warnings: 0, lines: [] }),
    // Nothing logged is nothing to show: an empty bag renders no panel at all,
    // rather than a heading over an empty list.
    finish: (bag) =>
      bag === undefined || bag.total === 0
        ? {}
        : { total: bag.total, errors: bag.errors, warnings: bag.warnings, lines: bag.lines },
  } satisfies ProfilerCollector<LogBag>
}

/** What the emitter must give the log collector. Structural, as above. */
export interface LogEventSource {
  on(event: string, listener: (payload: unknown) => void): unknown
}

/** As many lines as are worth scrolling; the count stays true past it. */
const LINE_CAP = 200

export interface LogLine {
  level: string
  message: string
  time?: string
  /** Milliseconds since the request arrived. */
  at: number
  context?: unknown
}

export interface LogBag {
  scope: CollectionScope
  total: number
  errors: number
  warnings: number
  lines: LogLine[]
}

/** Fields of a log entry that are its envelope, not its context. */
const LOG_ENVELOPE = new Set(['level', 'message', 'msg', 'timestamp', 'time'])

function toLine(payload: unknown, at: number): LogLine {
  const entry = asRecord(payload)
  const message = entry.message ?? entry.msg
  const context = Object.fromEntries(
    Object.entries(entry).filter(([key]) => !LOG_ENVELOPE.has(key)),
  )
  return {
    level: typeof entry.level === 'string' ? entry.level : 'info',
    message: typeof message === 'string' ? message : String(message ?? ''),
    at: round(at),
    ...(typeof entry.timestamp === 'string' ? { time: entry.timestamp } : {}),
    ...(Object.keys(context).length > 0 ? { context: preview(context) } : {}),
  }
}

/**
 * Every event the application emitted while the request ran — mail sent,
 * authorisation checks, the application's own domain events.
 *
 * It reads them through the emitter's `tap`, which runs in the emitting code's
 * async context. `onAny` would not do: it is delivered through the native bus,
 * later and outside the request. Queries, log lines and cache operations are
 * left out: they have their own panels.
 */
export function eventsCollector(
  source: EventTapSource,
  read: () => EventBag | undefined,
): ProfilerCollector<EventBag> {
  source.tap((name, data) => {
    if (hasOwnPanel(name)) return
    const bag = read()
    if (bag === undefined) return
    bag.total += 1
    if (bag.events.length < EVENT_CAP) {
      bag.events.push({ name, at: round(bag.scope.elapsed()), data: preview(data) })
    }
  })

  return {
    name: 'events',
    badge: (data) => {
      const total = typeof data.total === 'number' ? data.total : 0
      return total === 0 ? undefined : `${total} ${total === 1 ? 'event' : 'events'}`
    },
    start: (scope) => ({ scope, total: 0, events: [] }),
    finish: (bag) =>
      bag === undefined || bag.total === 0
        ? {}
        : { total: bag.total, events: bag.events, capped: bag.total > bag.events.length },
  }
}

/** Events that already have a panel of their own. */
const OWN_PANEL = new Set(['db:query', 'log:line'])

function hasOwnPanel(name: string): boolean {
  return OWN_PANEL.has(name) || name.startsWith(CACHE_PREFIX)
}

const EVENT_CAP = 300

/** What the emitter must give the events collector. Structural. */
export interface EventTapSource {
  tap(observer: (event: string, data: unknown) => void): unknown
}

export interface EventBag {
  scope: CollectionScope
  total: number
  events: Array<{ name: string; at: number; data: unknown }>
}

/**
 * What the cache did during the request: every hit, miss, write, delete,
 * clear and expiry, timed, per store.
 *
 * Off the same tap as the events panel, for the same reason, and kept apart
 * from it: counted from a capped event list, a request busy enough to fill it
 * showed a hit rate made of whatever fitted. The counts here stay true past
 * the listing cap, as the query panel's do.
 *
 * `cache:*` is the vocabulary `@c9up/echo` emits, upstream's names. A cache
 * that also reports `duration` (milliseconds) and, on a write, `ttl` (seconds,
 * null for no expiry) gets them shown; one that does not still gets its
 * operations counted and listed.
 */
export function cacheCollector(
  source: EventTapSource,
  read: () => CacheBag | undefined,
): ProfilerCollector<CacheBag> {
  source.tap((name, data) => {
    if (!name.startsWith(CACHE_PREFIX)) return
    const bag = read()
    if (bag === undefined) return
    const operation = toOperation(name.slice(CACHE_PREFIX.length), data, bag.scope.elapsed())
    count(bag, operation)
    if (bag.operations.length < CACHE_CAP) bag.operations.push(operation)
  })

  return {
    name: 'cache',
    badge: (data) => {
      const total = typeof data.total === 'number' ? data.total : 0
      if (total === 0) return undefined
      const label = `${total} cache ${total === 1 ? 'operation' : 'operations'}`
      return data.timed === true && typeof data.duration === 'number'
        ? `${label} · ${round(data.duration)} ms`
        : label
    },
    start: (scope) => ({
      scope,
      total: 0,
      duration: 0,
      timed: false,
      hits: 0,
      graced: 0,
      misses: 0,
      writes: 0,
      deletes: 0,
      clears: 0,
      expirations: 0,
      stores: new Map(),
      operations: [],
    }),
    // A request that never touched the cache has no cache panel.
    finish: (bag) =>
      bag === undefined || bag.total === 0
        ? {}
        : {
            total: bag.total,
            duration: round(bag.duration),
            timed: bag.timed,
            hits: bag.hits,
            graced: bag.graced,
            misses: bag.misses,
            writes: bag.writes,
            deletes: bag.deletes,
            clears: bag.clears,
            expirations: bag.expirations,
            stores: [...bag.stores.values()].map((store) => ({
              ...store,
              duration: round(store.duration),
            })),
            operations: bag.operations,
            capped: bag.total > bag.operations.length,
          },
  }
}

const CACHE_PREFIX = 'cache:'

/** As many operations as are worth scrolling; the counts stay true past it. */
const CACHE_CAP = 300

/** One cache operation, as the panel shows it. */
export interface CacheOperation {
  /** The event name past `cache:` — hit, miss, written, deleted, cleared, expire. */
  operation: string
  key?: string
  store: string
  /** When it started, milliseconds since the request arrived. */
  at: number
  /** Milliseconds, when the cache reports it. */
  duration?: number
  /** A hit served from an entry past its TTL, inside its grace window. */
  graced?: boolean
  /** Seconds a written entry lives, `null` when it never expires. */
  ttl?: number | null
  value?: unknown
}

/** One store's share of the operations. */
export interface CacheStoreSummary {
  name: string
  total: number
  hits: number
  misses: number
  writes: number
  deletes: number
  duration: number
}

export interface CacheBag {
  scope: CollectionScope
  total: number
  duration: number
  /** Whether any operation reported its duration. */
  timed: boolean
  /** Every hit, graced ones included. */
  hits: number
  graced: number
  misses: number
  writes: number
  deletes: number
  clears: number
  expirations: number
  stores: Map<string, CacheStoreSummary>
  operations: CacheOperation[]
}

function toOperation(operation: string, data: unknown, elapsed: number): CacheOperation {
  const event = asRecord(data)
  const duration = finiteNumber(event.duration)
  const key = typeof event.key === 'string' ? event.key : undefined
  const ttl = event.ttl === null ? null : finiteNumber(event.ttl)
  return {
    operation,
    ...(key === undefined ? {} : { key: String(preview(key)) }),
    store: typeof event.store === 'string' && event.store !== '' ? event.store : 'default',
    // The event arrives when the operation ENDS: it started `duration` ago.
    at: round(Math.max(0, elapsed - (duration ?? 0))),
    ...(duration === undefined ? {} : { duration: round(duration) }),
    ...(event.graced === true ? { graced: true } : {}),
    ...(ttl === undefined ? {} : { ttl }),
    // A value cached under a key that names a secret is that secret: the
    // key decides, as a field name does in any other payload.
    ...('value' in event
      ? { value: key !== undefined && isSecretKey(key) ? REDACTED : preview(event.value) }
      : {}),
  }
}

function count(bag: CacheBag, operation: CacheOperation): void {
  const store = bag.stores.get(operation.store) ?? {
    name: operation.store,
    total: 0,
    hits: 0,
    misses: 0,
    writes: 0,
    deletes: 0,
    duration: 0,
  }
  bag.stores.set(operation.store, store)
  bag.total += 1
  store.total += 1
  if (operation.duration !== undefined) {
    bag.timed = true
    bag.duration += operation.duration
    store.duration += operation.duration
  }
  switch (operation.operation) {
    case 'hit':
      bag.hits += 1
      store.hits += 1
      if (operation.graced === true) bag.graced += 1
      break
    case 'miss':
      bag.misses += 1
      store.misses += 1
      break
    case 'written':
      bag.writes += 1
      store.writes += 1
      break
    case 'deleted':
      bag.deletes += 1
      store.deletes += 1
      break
    case 'cleared':
      bag.clears += 1
      break
    case 'expire':
      bag.expirations += 1
      break
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Heap and resident memory once the request is answered. */
export function memoryCollector(): ProfilerCollector<{ start: number }> {
  return {
    name: 'memory',
    badge: (data) => (typeof data.usedMb === 'number' ? `${data.usedMb.toFixed(1)} MB` : undefined),
    start: () => ({ start: process.memoryUsage().heapUsed }),
    finish: (bag) => {
      const usage = process.memoryUsage()
      return {
        usedMb: usage.heapUsed / MB,
        totalMb: usage.heapTotal / MB,
        rssMb: usage.rss / MB,
        deltaMb: bag === undefined ? 0 : (usage.heapUsed - bag.start) / MB,
      }
    },
  }
}

const MB = 1024 * 1024

/** The application and the runtime it answered on: the bar's right-hand item. */
export function appCollector(info: { version?: string; environment?: string } = {}) {
  return {
    name: 'app',
    start: () => undefined,
    finish: () => ({
      ...(info.version === undefined ? {} : { ream: info.version }),
      node: process.version,
      environment: info.environment ?? process.env.NODE_ENV ?? 'development',
      platform: `${process.platform}-${process.arch}`,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
    }),
  } satisfies ProfilerCollector<undefined>
}

function toQuery(payload: unknown, at: number): RecordedQuery {
  const event = asRecord(payload)
  return {
    sql: typeof event.sql === 'string' ? event.sql : String(event.sql ?? ''),
    bindings: Array.isArray(event.bindings) ? event.bindings.map((value) => preview(value)) : [],
    duration: round(durationOf(payload)),
    at: round(at),
    ...pickString(event, 'connection'),
    ...pickString(event, 'model'),
    ...pickString(event, 'method'),
    ...(event.inTransaction === true ? { inTransaction: true } : {}),
    ...(event.error instanceof Error ? { error: event.error.message } : {}),
  }
}

function isFailed(payload: unknown): boolean {
  return asRecord(payload).error instanceof Error
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

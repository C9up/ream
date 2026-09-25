/**
 * The profiler, assembled.
 *
 * One place that knows which collectors ship, so the Ignitor wires a profiler
 * rather than a list — and an application that wants its own panel adds a
 * collector here instead of rebuilding the set.
 */

import {
  databaseCollector,
  exceptionCollector,
  type LogBag,
  logCollector,
  memoryCollector,
  type QueryBag,
  type QueryEventSource,
  requestCollector,
} from './collectors.js'
import { MemoryProfileStore } from './MemoryProfileStore.js'
import { Profiler } from './Profiler.js'
import type { ProfilerCollector } from './types.js'

export * from './collectors.js'
export { profilerEndpoint } from './endpoint.js'
export { MemoryProfileStore } from './MemoryProfileStore.js'
export { profileRequest } from './middleware.js'
export { PROFILER_PATH, PROFILER_TOKEN_HEADER, Profiler } from './Profiler.js'
export { toolbarScript } from './toolbar.js'
export * from './types.js'

/**
 * The profiler a dev server runs with.
 *
 * `events` is the application's emitter. The database panel comes from
 * `db:query` on it, which is how a data layer reports a statement without the
 * profiler importing one.
 */
export function createProfiler(
  events: QueryEventSource,
  extra: readonly ProfilerCollector[] = [],
): Profiler {
  // Built before the profiler so the database collector can read the bag of
  // whichever request is running — the reference is filled in a line later,
  // and nothing reads it until a request arrives.
  let profiler: Profiler
  const collectors: ProfilerCollector[] = [
    requestCollector(),
    databaseCollector(events, () => profiler.current<QueryBag>('database')),
    exceptionCollector(),
    logCollector(events, () => profiler.current<LogBag>('logs')),
    memoryCollector(),
    ...extra,
  ]
  profiler = new Profiler(collectors, new MemoryProfileStore(collectors))
  return profiler
}

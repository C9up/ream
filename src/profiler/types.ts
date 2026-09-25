/**
 * What the profiler keeps about one request.
 *
 * Shaped after Symfony's profiler rather than Laravel's debugbar, which is a
 * decision about where the data lives: a token per request, an endpoint that
 * serves it, and a history. Inlining it in the page is simpler until the
 * request you need to look at was a POST that redirected — and then the data
 * is gone, which is exactly when you wanted it.
 */

/** One collector's contribution to a profile. Plain data: it crosses a wire. */
export type CollectedData = Record<string, unknown>

/**
 * Everything kept about one request.
 *
 * `token` identifies it. It travels back on `X-Debug-Token`, so a client — the
 * toolbar, curl, a test — can ask for the profile of a request it just made.
 */
export interface Profile {
  token: string
  /** When the request arrived, epoch milliseconds. */
  time: number
  method: string
  url: string
  status: number
  /** Wall-clock milliseconds, first middleware to serialised response. */
  duration: number
  /** Keyed by collector name. */
  data: Record<string, CollectedData>
}

/** A profile without its data — what a listing shows. */
export type ProfileSummary = Omit<Profile, 'data'> & {
  /** The headline each collector wants on the bar: `{ database: '12 queries' }`. */
  badges: Record<string, string>
}

/**
 * What a collector is handed while a request runs.
 *
 * Deliberately not the HttpContext: a collector observes, and handing it the
 * context would let it answer the request. What it needs is a place to put
 * what it saw and the ability to know when the request ends.
 */
export interface CollectionScope {
  token: string
  /** Called by the framework when the request is done. */
  readonly startedAt: number
}

/**
 * A source of data about a request.
 *
 * `start` runs when the request begins and answers a bag the collector will
 * fill; `finish` turns that bag into what is stored. Two methods rather than
 * one, because the interesting collectors — queries, logs, events — are fed by
 * things happening DURING the request, not by looking at it afterwards.
 */
export interface ProfilerCollector<Bag = unknown> {
  /** Unique. It keys the data and names the panel. */
  readonly name: string
  /** Shown on the bar, or nothing when there is nothing worth a badge. */
  badge?: (data: CollectedData) => string | undefined
  start(scope: CollectionScope): Bag
  finish(bag: Bag, scope: CollectionScope): CollectedData
}

/** Where profiles are kept. Bounded: a dev session is not an archive. */
export interface ProfileStore {
  save(profile: Profile): void
  find(token: string): Profile | undefined
  recent(limit?: number): ProfileSummary[]
  clear(): void
}

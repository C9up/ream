/**
 * The profiler: one profile per request, and the token that finds it again.
 *
 * The hard part is attribution. A SQL query is reported by a listener the
 * database package calls, with no idea which request caused it — and in a
 * server answering three requests at once, "the current request" is not a
 * variable anything can hold. `AsyncLocalStorage` is what makes it one: the
 * request runs inside a store, and whatever a collector does during it, however
 * deep in the await chain, lands in the right bag.
 *
 * Dev only, and hard-gated: a profiler that kept every request in production
 * would be a memory leak wearing a feature's name.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { CollectionScope, Profile, ProfilerCollector, ProfileStore } from './types.js'

/** What is live while one request runs. */
interface ActiveProfile {
  scope: CollectionScope
  /** Each collector's bag, keyed by collector name. */
  bags: Map<string, unknown>
}

/** Where the toolbar and the profiler page are served. */
export const PROFILER_PATH = '/__ream/profiler'

/** The header carrying the token back, so a client can ask for the profile. */
export const PROFILER_TOKEN_HEADER = 'x-debug-token'

export class Profiler {
  readonly #storage = new AsyncLocalStorage<ActiveProfile>()
  readonly #collectors: readonly ProfilerCollector[]
  readonly #store: ProfileStore

  constructor(collectors: readonly ProfilerCollector[], store: ProfileStore) {
    this.#collectors = collectors
    this.#store = store
  }

  get store(): ProfileStore {
    return this.#store
  }

  get collectors(): readonly ProfilerCollector[] {
    return this.#collectors
  }

  /**
   * Run one request inside a profile.
   *
   * `work` is handed the scope so it can stamp the token on the response
   * before anything else runs: a request that throws unwinds past its caller,
   * and a token written after the await would be missing on exactly the
   * request worth looking at.
   *
   * `describe` is called AFTER the work, because the status is only known
   * then — asking for it up front would record the request as it arrived
   * rather than as it was answered. It is given whatever was thrown, since a
   * handler that threw has not had its status written yet.
   */
  async profile<T>(
    request: { method: string; url: string },
    work: (scope: CollectionScope) => Promise<T>,
    describe: (error?: unknown) => { status: number },
  ): Promise<{ result: T; token: string }> {
    const token = newToken()
    const startedAt = Date.now()
    const started = performance.now()
    const active: ActiveProfile = { scope: { token, startedAt }, bags: new Map() }

    for (const collector of this.#collectors) {
      // A collector that throws while starting must not fail the request it was
      // only meant to watch.
      try {
        active.bags.set(collector.name, collector.start(active.scope))
      } catch {
        active.bags.set(collector.name, undefined)
      }
    }

    // A request that threw is the profile you most want to look at, so it is
    // recorded like any other and the error is re-thrown afterwards. Losing it
    // here would mean the profiler goes quiet exactly when something broke.
    let result: T | undefined
    let thrown: unknown
    let failed = false
    try {
      result = await this.#storage.run(active, () => work(active.scope))
    } catch (error) {
      thrown = error
      failed = true
      recordException(active, error)
    }

    const profile: Profile = {
      token,
      time: startedAt,
      method: request.method,
      url: request.url,
      status: safeStatus(describe, thrown),
      duration: performance.now() - started,
      data: {},
    }
    for (const collector of this.#collectors) {
      try {
        profile.data[collector.name] = collector.finish(
          active.bags.get(collector.name),
          active.scope,
        )
      } catch {
        // Same rule on the way out: one broken panel, not a broken response.
        profile.data[collector.name] = {}
      }
    }
    this.#store.save(profile)
    if (failed) throw thrown
    // Only reachable when the work resolved, which is when `result` is set.
    return { result: result as T, token }
  }

  /**
   * The bag of the collector named, for the request running right now.
   *
   * `undefined` outside a request — a query from a console command, a boot-time
   * warm-up — and a collector that writes into it must accept that.
   */
  current<Bag>(collector: string): Bag | undefined {
    const active = this.#storage.getStore()
    if (active === undefined) return undefined
    const bag = active.bags.get(collector)
    return bag === undefined ? undefined : (bag as Bag)
  }

  /** Whether a request is being profiled right now. */
  get active(): boolean {
    return this.#storage.getStore() !== undefined
  }
}

/**
 * Put the error where the exception panel reads it.
 *
 * The collector's own bag, by name: the framework ships that collector, and a
 * profiler that could not say what broke would miss the reason most people
 * open it.
 */
function recordException(active: ActiveProfile, error: unknown): void {
  const bag = active.bags.get('exception')
  if (typeof bag !== 'object' || bag === null) return
  const target: Record<string, unknown> = Object.assign(bag)
  if (error instanceof Error) {
    target.name = error.name
    target.message = error.message
    if (error.stack !== undefined) target.stack = error.stack
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') target.code = code
  } else {
    target.name = 'Error'
    target.message = String(error)
  }
}

/**
 * A token, short enough to read aloud and random enough not to collide.
 *
 * Six bytes of hex, as Symfony's is six characters: it identifies a request
 * within one dev session, not across the internet.
 */
function newToken(): string {
  return randomBytes(6).toString('hex')
}

function safeStatus(describe: (error?: unknown) => { status: number }, error: unknown): number {
  try {
    const { status } = describe(error)
    return Number.isInteger(status) ? status : 0
  } catch {
    return 0
  }
}

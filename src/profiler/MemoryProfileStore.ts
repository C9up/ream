/**
 * Where profiles live during a dev session.
 *
 * In memory and bounded. Symfony writes its profiles to disk so they survive a
 * restart; here a restart is the common case — every saved file changes it —
 * and a dev server that grows a directory nobody empties is a worse trade than
 * losing the history of the session you just ended.
 *
 * The bound is a count, not a size: a profile holding 400 queries is the one
 * you most want to keep, and dropping it for being big would lose exactly the
 * request worth looking at.
 */

import type { Profile, ProfilerCollector, ProfileStore, ProfileSummary } from './types.js'

/** How many requests are remembered. Enough to walk back through a flow. */
const DEFAULT_LIMIT = 50

export class MemoryProfileStore implements ProfileStore {
  readonly #profiles = new Map<string, Profile>()
  readonly #limit: number
  readonly #collectors: readonly ProfilerCollector[]

  constructor(collectors: readonly ProfilerCollector[] = [], limit = DEFAULT_LIMIT) {
    this.#collectors = collectors
    this.#limit = Math.max(1, limit)
  }

  save(profile: Profile): void {
    this.#profiles.set(profile.token, profile)
    // A Map iterates in insertion order, so the oldest key is the first one.
    while (this.#profiles.size > this.#limit) {
      const oldest = this.#profiles.keys().next()
      if (oldest.done === true) break
      this.#profiles.delete(oldest.value)
    }
  }

  find(token: string): Profile | undefined {
    return this.#profiles.get(token)
  }

  /** Newest first, which is the order anyone reading a history wants. */
  recent(limit = 20): ProfileSummary[] {
    const summaries: ProfileSummary[] = []
    for (const profile of [...this.#profiles.values()].reverse()) {
      if (summaries.length >= limit) break
      summaries.push(this.#summarise(profile))
    }
    return summaries
  }

  clear(): void {
    this.#profiles.clear()
  }

  /**
   * The headline each collector wants shown.
   *
   * Asked of the collector rather than computed here: what counts as the
   * headline of a panel is the panel's business, and a store that knew would
   * have to be changed every time one is added.
   */
  #summarise(profile: Profile): ProfileSummary {
    const badges: Record<string, string> = {}
    for (const collector of this.#collectors) {
      const data = profile.data[collector.name]
      if (data === undefined || collector.badge === undefined) continue
      const badge = collector.badge(data)
      if (badge !== undefined) badges[collector.name] = badge
    }
    const { data: _data, ...rest } = profile
    return { ...rest, badges }
  }
}

/**
 * Redis lock backend — the one a second replica needs.
 *
 * Without a shared lock, every instance of an application runs every
 * scheduled task on every tick: a nightly invoice run goes out N times,
 * a reminder email arrives N times, and nothing in the logs says so.
 * `MemoryLockBackend` does not close that gap — each process keeps its
 * own map — and the scheduler locks nothing at all by default.
 *
 * No import of a Redis package. The client is taken structurally — `set`
 * and `eval` — so this works against a `@c9up/quasar` connection without
 * ream depending on quasar, which is an optional peer.
 */

import { randomUUID } from 'node:crypto'
import { assertValidTtl, type LockBackend } from './LockBackend.js'

/** The commands this issues. Any client answering them will do. */
export interface LockRedisClient {
  /** `SET key value PX <ttl> NX` — answers null when the key already exists. */
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>
  /** `EVAL script numKeys ...` — used for the compare-and-delete release. */
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>
}

/**
 * How the backend gets its client: the client itself, or something that
 * answers with one.
 *
 * The resolver form is what a config file needs. `config/scheduler.ts` is
 * read before the application boots, so the connection does not exist yet
 * and cannot be awaited there — a function defers the lookup to the first
 * task that fires.
 */
export type LockRedisResolver = LockRedisClient | (() => LockRedisClient | Promise<LockRedisClient>)

export interface RedisLockBackendOptions {
  /** Key prefix. Default `"ream:schedule:lock:"`. */
  prefix?: string
}

/**
 * Release only a lease we still hold.
 *
 * A plain `DEL` is the classic way to break this: a task that outlives its
 * TTL loses the lock, another instance acquires it and starts running, and
 * the first one then deletes THAT instance's lease on its way out — leaving
 * the name free while a task is still running under it. Comparing the token
 * before deleting makes the release a no-op once the lease is no longer ours.
 */
const RELEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

export class RedisLockBackend implements LockBackend {
  readonly #source: LockRedisResolver
  readonly #prefix: string
  #resolved: Promise<LockRedisClient> | undefined
  /** Our token per held name, so a release can prove the lease is ours. */
  readonly #tokens = new Map<string, string>()

  constructor(client: LockRedisResolver, options: RedisLockBackendOptions = {}) {
    this.#source = client
    this.#prefix = options.prefix ?? 'ream:schedule:lock:'
  }

  /** The client, resolved once and kept. */
  #client(): Promise<LockRedisClient> {
    if (!this.#resolved) {
      this.#resolved = Promise.resolve(
        typeof this.#source === 'function' ? this.#source() : this.#source,
      )
    }
    return this.#resolved
  }

  #key(name: string): string {
    return `${this.#prefix}${name}`
  }

  /**
   * `SET key token PX ttl NX` — one round trip, atomic on the server, which
   * is what makes the decision the same for every instance asking at once.
   *
   * The TTL is what recovers the lock after a crash: an instance that dies
   * holding it never releases, and the lease simply expires.
   */
  async acquire(name: string, ttlMs: number): Promise<boolean> {
    assertValidTtl(ttlMs)
    const client = await this.#client()
    const token = randomUUID()
    // Redis takes an integer number of milliseconds; a fractional TTL is a
    // protocol error, not a rounding detail.
    const result = await client.set(this.#key(name), token, 'PX', Math.ceil(ttlMs), 'NX')
    if (result === null || result === undefined) return false
    this.#tokens.set(name, token)
    return true
  }

  /**
   * Idempotent, as the contract requires: releasing a name this instance
   * never acquired — or one whose lease has since expired — does nothing.
   */
  async release(name: string): Promise<void> {
    const token = this.#tokens.get(name)
    if (token === undefined) return
    this.#tokens.delete(name)
    const client = await this.#client()
    await client.eval(RELEASE, 1, this.#key(name), token)
  }
}

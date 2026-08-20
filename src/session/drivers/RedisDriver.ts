/**
 * Server-side sessions on Redis — what `Session.ts` has documented as a
 * pluggable driver from the start, and what `SessionMiddleware` points at when
 * a cookie session outgrows its 4KB.
 *
 * The client is structural, so ream depends on no Redis package: hand it an
 * ioredis/node-redis client, or a `@c9up/quasar` connection, or anything that
 * carries these four commands.
 */

import type { SessionDriver } from '../Session.js'

/** The commands a session needs. Compatible with ioredis and node-redis. */
export interface SessionRedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>
  del(key: string | string[]): Promise<number>
  expire(key: string, seconds: number): Promise<number>
}

/** Where the client comes from — resolved once, on the first request that needs it. */
export type SessionRedisClientSource =
  | SessionRedisClient
  | (() => SessionRedisClient | Promise<SessionRedisClient>)

export interface RedisSessionOptions {
  /** Key prefix. Namespacing matters: a session store usually shares a database. */
  prefix?: string
}

export class RedisDriver implements SessionDriver {
  readonly #source: SessionRedisClientSource
  #resolved: SessionRedisClient | undefined
  #pending: Promise<SessionRedisClient> | undefined
  readonly #prefix: string

  constructor(source: SessionRedisClientSource, options: RedisSessionOptions = {}) {
    this.#source = source
    this.#prefix = options.prefix ?? 'ream:session:'
  }

  /**
   * The client, resolved once. Requests racing on a cold start must not each
   * open their own connection, so the in-flight promise is shared.
   */
  async #client(): Promise<SessionRedisClient> {
    if (this.#resolved) return this.#resolved
    if (typeof this.#source !== 'function') {
      this.#resolved = this.#source
      return this.#resolved
    }
    if (!this.#pending) {
      const resolver = this.#source
      this.#pending = Promise.resolve(resolver()).then((client) => {
        this.#resolved = client
        this.#pending = undefined
        return client
      })
    }
    return this.#pending
  }

  #key(sessionId: string): string {
    return `${this.#prefix}${sessionId}`
  }

  /**
   * Unreadable payloads are treated as an absent session rather than thrown.
   * A corrupt value would otherwise 500 every request carrying that cookie,
   * with no way for the visitor to recover — a new session is the safe answer.
   */
  async read(sessionId: string): Promise<Record<string, unknown>> {
    const client = await this.#client()
    const raw = await client.get(this.#key(sessionId))
    if (raw === null) return {}

    try {
      const parsed: unknown = JSON.parse(raw)
      return isPlainRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    const client = await this.#client()
    // EX in one command: a SET followed by an EXPIRE leaves the key immortal
    // if the process dies between the two.
    await client.set(this.#key(sessionId), JSON.stringify(data), 'EX', ttl)
  }

  async destroy(sessionId: string): Promise<void> {
    const client = await this.#client()
    await client.del(this.#key(sessionId))
  }

  /** Slide the expiry — a session must not die while its owner is active. */
  async touch(sessionId: string, ttl: number): Promise<void> {
    const client = await this.#client()
    await client.expire(this.#key(sessionId), ttl)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

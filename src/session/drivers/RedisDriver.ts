/**
 * Server-side sessions on Redis — what `Session.ts` has documented as a
 * pluggable driver from the start, and what `SessionMiddleware` points at when
 * a cookie session outgrows its 4KB.
 *
 * The client is structural, so ream depends on no Redis package: hand it an
 * ioredis/node-redis client, or a `@c9up/quasar` connection, or anything that
 * carries these four commands.
 */

import type { SessionDriverWithTagging, TaggedSession } from '../Session.js'

/** The commands a session needs. Compatible with ioredis and node-redis. */
export interface SessionRedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>
  del(key: string | string[]): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  /** Set commands, needed only for session tagging. Every real client has them. */
  sadd?(key: string, ...members: string[]): Promise<number>
  srem?(key: string, ...members: string[]): Promise<number>
  smembers?(key: string): Promise<string[]>
  exists?(key: string): Promise<number>
}

/** The set commands session tagging needs, over and above the base four. */
const SET_COMMANDS = ['sadd', 'srem', 'smembers', 'exists'] as const

/** A client that carries them. */
type TaggingRedisClient = SessionRedisClient &
  Required<Pick<SessionRedisClient, (typeof SET_COMMANDS)[number]>>

function hasSetCommands(client: SessionRedisClient): client is TaggingRedisClient {
  return SET_COMMANDS.every((command) => typeof client[command] === 'function')
}

/** Where the client comes from — resolved once, on the first request that needs it. */
export type SessionRedisClientSource =
  | SessionRedisClient
  | (() => SessionRedisClient | Promise<SessionRedisClient>)

export interface RedisSessionOptions {
  /** Key prefix. Namespacing matters: a session store usually shares a database. */
  prefix?: string
}

export class RedisDriver implements SessionDriverWithTagging {
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
      // `finally`, not the success path: clearing it only on success left a
      // REJECTED promise in the slot, and every later call returned that same
      // rejection. One refused connection at boot — Redis still starting, a
      // network blip — and the driver never tried again for the life of the
      // process. Bay and echo already clear it this way.
      this.#pending = Promise.resolve(resolver())
        .then((client) => {
          this.#resolved = client
          return client
        })
        .finally(() => {
          this.#pending = undefined
        })
    }
    return this.#pending
  }

  #key(sessionId: string): string {
    return `${this.#prefix}${sessionId}`
  }

  /** Where the set of a user's session ids lives. */
  #tagKey(userId: string | number): string {
    return `${this.#prefix}tag:${userId}`
  }

  /**
   * The client, narrowed to one that carries the set commands.
   *
   * They are optional on {@link SessionRedisClient} so a four-command shim
   * still satisfies the store contract. A real client has them; a shim that
   * does not gets told which command is missing, rather than a tag that
   * silently does nothing and a "log out everywhere" that logs nobody out.
   */
  async #taggingClient(method: string): Promise<TaggingRedisClient> {
    const client = await this.#client()
    const missing = SET_COMMANDS.find((command) => typeof client[command] !== 'function')
    if (missing !== undefined) {
      throw new Error(
        `session.${method}() needs the Redis \`${missing.toUpperCase()}\` command, which the configured client does not expose.`,
      )
    }
    if (!hasSetCommands(client)) {
      // Unreachable: `missing` already proved every command is there. The guard
      // is what tells the type system so, without asserting it.
      throw new Error(`session.${method}() could not narrow the Redis client.`)
    }
    return client
  }

  /**
   * Unreadable payloads are treated as an absent session rather than thrown.
   * A corrupt value would otherwise 500 every request carrying that cookie,
   * with no way for the visitor to recover — a new session is the safe answer.
   */
  async read(sessionId: string): Promise<Record<string, unknown> | null> {
    const client = await this.#client()
    const raw = await client.get(this.#key(sessionId))
    if (raw === null) return null

    try {
      const parsed: unknown = JSON.parse(raw)
      return isPlainRecord(parsed) ? parsed : null
    } catch {
      return null
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

  async tag(sessionId: string, userId: string | number): Promise<void> {
    const client = await this.#taggingClient('tag')
    await client.sadd(this.#tagKey(userId), sessionId)
  }

  async untag(sessionId: string, userId: string | number): Promise<void> {
    const client = await this.#taggingClient('untag')
    await client.srem(this.#tagKey(userId), sessionId)
  }

  async tagged(userId: string | number): Promise<TaggedSession[]> {
    const client = await this.#taggingClient('tagged')
    const key = this.#tagKey(userId)
    const ids = await client.smembers(key)
    const sessions: TaggedSession[] = []
    const stale: string[] = []
    for (const id of ids) {
      // A member whose session key expired is not an active device. Redis
      // cannot expire set members individually, so the set is pruned here —
      // otherwise it grows with every session the user ever opened.
      if ((await client.exists(this.#key(id))) === 0) {
        stale.push(id)
        continue
      }
      // The EXISTS check above already established the key is there; a null
      // here means it expired in the gap, and that device is no longer active.
      const data = await this.read(id)
      if (data === null) {
        stale.push(id)
        continue
      }
      sessions.push({ id, data })
    }
    if (stale.length > 0) await client.srem(key, ...stale)
    return sessions
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

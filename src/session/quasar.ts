/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Ream does not depend on quasar: it is an optional peer, and this module
 * never imports it statically. The specifier is built at runtime so the
 * TypeScript build stays free of it too — a hard type import would make ream
 * unbuildable for anyone using cookie or memory sessions.
 *
 * The shape is checked before use rather than asserted, the same way ream
 * duck-types what it does not own.
 */

import type { SessionRedisClient } from './drivers/RedisDriver.js'

/** The slice of quasar's manager this needs: a connection, by name. */
interface ConnectionSource {
  connection(name?: string): unknown
}

function isConnectionSource(value: unknown): value is ConnectionSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'connection') === 'function'
  )
}

function isSessionRedisClient(value: unknown): value is SessionRedisClient {
  if (typeof value !== 'object' || value === null) return false
  // The commands this driver actually issues. A connection missing one of
  // them would fail on the first request carrying a session, far from the cause.
  const required = [
    'get',
    'set',
    'del',
    'exists',
    'keys',
    'sadd',
    'srem',
    'smembers',
    'expire',
    'ttl',
  ]
  return required.every((name) => typeof Reflect.get(value, name) === 'function')
}

/**
 * A resolver for `session.driver = 'redis'` — quasar is loaded on the
 * first request that reads a session, not at config time.
 */
export function quasarConnection(name?: string): () => Promise<SessionRedisClient> {
  return async () => {
    const specifier = '@c9up/quasar/services/main'
    let loaded: unknown
    try {
      loaded = await import(/* @vite-ignore */ specifier)
    } catch (cause) {
      throw new Error(
        `Ream: the '${name ?? 'default'}' session store asks for a quasar connection, but @c9up/quasar is not installed.\n` +
          '  pnpm add @c9up/quasar',
        { cause },
      )
    }

    const manager = isConnectionSource(loaded) ? loaded : Reflect.get(Object(loaded), 'default')
    if (!isConnectionSource(manager)) {
      throw new Error('Ream: @c9up/quasar/services/main did not expose a connection() manager')
    }

    const connection = manager.connection(name)
    if (!isSessionRedisClient(connection)) {
      throw new Error(
        `Ream: quasar connection '${name ?? 'default'}' does not carry the commands a session needs`,
      )
    }
    return connection
  }
}

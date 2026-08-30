/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Ream does not depend on quasar: it is an optional peer, and this module
 * never imports it statically. The specifier is built at runtime so the
 * TypeScript build stays free of it too — a hard type import would make
 * ream unbuildable for anyone scheduling on a single instance.
 *
 * Same bridge the session store uses, for the same reason.
 */

import type { LockRedisClient } from './RedisLockBackend.js'

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

/**
 * The commands the backend issues, checked before use: a connection missing
 * one would fail on the first task that fires, far from the cause.
 */
function isLockRedisClient(value: unknown): value is LockRedisClient {
  if (typeof value !== 'object' || value === null) return false
  return ['set', 'eval'].every((name) => typeof Reflect.get(value, name) === 'function')
}

/**
 * A resolver for `locks.redis({ connection })` — quasar is loaded when the
 * first task fires, not while the config file is read.
 */
export function quasarConnection(name?: string): () => Promise<LockRedisClient> {
  return async () => {
    const specifier = '@c9up/quasar/services/main'
    let loaded: unknown
    try {
      loaded = await import(/* @vite-ignore */ specifier)
    } catch (cause) {
      throw new Error(
        `Ream: the scheduler lock asks for the '${name ?? 'default'}' quasar connection, but @c9up/quasar is not installed.\n` +
          '  pnpm add @c9up/quasar',
        { cause },
      )
    }

    const manager = isConnectionSource(loaded) ? loaded : Reflect.get(Object(loaded), 'default')
    if (!isConnectionSource(manager)) {
      throw new Error('Ream: @c9up/quasar/services/main did not expose a connection() manager')
    }

    const connection = manager.connection(name)
    if (!isLockRedisClient(connection)) {
      throw new Error(
        `Ream: quasar connection '${name ?? 'default'}' does not carry the commands a scheduler lock needs`,
      )
    }
    return connection
  }
}

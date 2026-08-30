/**
 * The lock backends a scheduler config names.
 *
 *   // config/scheduler.ts
 *   import { defineConfig, locks } from '@c9up/ream'
 *
 *   export default defineConfig({
 *     lock: locks.redis({ connection: 'main' }),
 *   })
 *
 * Without a lock the scheduler runs every task on every instance, which is
 * correct while there is one, and duplicates every run once there are two.
 *
 * Factories are lazy: the backend is built when the scheduler is, so naming
 * a Redis lock in a config that runs single-instance costs nothing until it
 * is selected.
 */

import type { LockBackend } from './LockBackend.js'
import { MemoryLockBackend } from './MemoryLockBackend.js'
import { quasarConnection } from './quasar.js'
import { type LockRedisResolver, RedisLockBackend } from './RedisLockBackend.js'

/** A lock backend, built on first use. */
export type LockBackendFactory = () => LockBackend

export const locks = {
  /**
   * In this process's memory. Two processes each keep their own, so this
   * bounds nothing across replicas — it is for a single-process deployment
   * and for tests.
   */
  memory(): LockBackendFactory {
    return () => new MemoryLockBackend()
  },

  /**
   * Redis. `connection` takes a client, a function answering one, or the
   * NAME of a `@c9up/quasar` connection — the last of which is resolved at
   * runtime without ream importing quasar, which stays an optional peer.
   */
  redis(options: { connection: LockRedisResolver | string; prefix?: string }): LockBackendFactory {
    const client: LockRedisResolver =
      typeof options.connection === 'string'
        ? quasarConnection(options.connection)
        : options.connection
    return () => new RedisLockBackend(client, { prefix: options.prefix })
  },
}

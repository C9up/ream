/**
 * Author-time config for `config/scheduler.ts`.
 *
 *   import { defineConfig, locks } from '@c9up/ream/scheduler/config'
 *
 *   export default defineConfig({
 *     lock: locks.redis({ connection: 'main' }),
 *   })
 */

import type { LockBackend } from './locks/LockBackend.js'
import type { LockBackendFactory } from './locks/locks.js'

export interface SchedulerConfig {
  /**
   * The lock consulted before a task fires, so that only one instance runs
   * it. Takes a backend, or a factory answering one — which is what the
   * `locks.*` helpers return, so a config file can name a Redis lock before
   * the connection exists.
   *
   * Left out, the scheduler locks nothing: every instance runs every task.
   * Correct on one instance, and a duplicate run per replica past that.
   */
  lock?: LockBackend | LockBackendFactory
  /** How long a lease is held before it expires on its own. Default 60 000. */
  defaultLockTtlMs?: number
}

export function defineConfig(config: SchedulerConfig): SchedulerConfig {
  return config
}

export type { LockBackend } from './locks/LockBackend.js'
export { type LockBackendFactory, locks } from './locks/locks.js'

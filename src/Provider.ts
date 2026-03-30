/**
 * Base Provider class — modules register via providers.
 *
 * @implements FR20
 *
 * Lifecycle (AdonisJS-compatible):
 *   register() → boot() → start() → ready() → ... → shutdown()
 */

import type { Container } from './container/Container.js'

export interface AppContext {
  container: Container
  config: ConfigStore
}

export interface ConfigStore {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
}

export abstract class Provider {
  protected app: AppContext

  constructor(app: AppContext) {
    this.app = app
  }

  /** Phase 1: Register bindings in the container (synchronous). */
  register(): void {}

  /** Phase 2: Boot — framework setup, verify connections. */
  async boot(): Promise<void> {}

  /** Phase 3: Start — before HTTP server starts. Import routes, warm caches. */
  async start(): Promise<void> {}

  /** Phase 4: Ready — app fully operational, HTTP server listening. */
  async ready(): Promise<void> {}

  /** Cleanup on shutdown (reverse order). */
  async shutdown(): Promise<void> {}
}

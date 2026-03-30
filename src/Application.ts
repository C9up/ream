/**
 * Application bootstrap — manages providers, config, and lifecycle.
 *
 * @implements FR17, FR20
 */

import { Container } from './container/Container.js'
import { SimpleConfigStore } from './ConfigLoader.js'
import type { Provider, AppContext, ConfigStore } from './Provider.js'

export class Application implements AppContext {
  readonly container: Container
  readonly config: ConfigStore
  private providers: Provider[] = []
  private booted = false

  constructor() {
    this.container = new Container()
    this.config = new SimpleConfigStore()
  }

  /** Register a provider instance. */
  register(provider: Provider): void {
    this.providers.push(provider)
    provider.register()
  }

  /** Boot all registered providers (Phase 2). */
  async boot(): Promise<void> {
    if (this.booted) return
    for (const provider of this.providers) {
      await provider.boot()
    }
    this.booted = true
  }

  /** Shutdown all providers in reverse order (Phase 3). */
  async shutdown(): Promise<void> {
    for (const provider of [...this.providers].reverse()) {
      await provider.shutdown()
    }
    this.booted = false
  }

  /** Get the number of registered providers. */
  get providerCount(): number {
    return this.providers.length
  }
}

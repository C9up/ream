import type { RegisteredMigrationSource } from './types.js'

/**
 * Where every store's migration runner registers itself.
 *
 * Bound in the container as `migrations`, always — an app with no data package
 * gets an EMPTY registry, never a missing binding. That distinction is what
 * lets the CLI tell "this app has no migrations" from "this app predates the
 * registry", and say something useful in each case instead of failing the same
 * way twice.
 */
export class MigrationRegistry {
  readonly #sources = new Map<string, RegisteredMigrationSource>()

  /**
   * Register a store's runner. Registering the same name twice is refused:
   * silently replacing it would mean one of two providers migrates nothing,
   * and the run would still report success.
   */
  register(source: RegisteredMigrationSource): this {
    if (this.#sources.has(source.name)) {
      throw new Error(
        `A migration source named '${source.name}' is already registered. Two providers cannot claim one name — one of them would migrate nothing while the run still reported success.`,
      )
    }
    this.#sources.set(source.name, source)
    return this
  }

  /** Every registered store, in registration order. */
  all(): RegisteredMigrationSource[] {
    return [...this.#sources.values()]
  }

  /** One store by name, or `undefined`. */
  get(name: string): RegisteredMigrationSource | undefined {
    return this.#sources.get(name)
  }

  /** The registered names, for an error message that lists what IS available. */
  names(): string[] {
    return [...this.#sources.keys()]
  }

  /** Whether anything registered. */
  get isEmpty(): boolean {
    return this.#sources.size === 0
  }
}

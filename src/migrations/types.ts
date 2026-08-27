/**
 * The contract a data package implements so `ream migrate` can drive it.
 *
 * REAM PARTICULARITY, deliberate — AdonisJS has no equivalent, because Lucid is
 * its only migration source: `node ace migration:run` can name it directly.
 * Ream expects several stores in one app (a relational one, a time-series one,
 * whatever comes next), so the CLI must not name any of them. A store registers
 * itself and the CLI stays generic for good.
 *
 * The vocabulary is Adonis' where Adonis has one: a status node is
 * `{ name, status, batch? }`, spelled `status` as Lucid's `MigrationListNode`
 * spells it.
 */

/** Whether a migration has run. */
export type MigrationState = 'applied' | 'pending'

/** One migration's position, as `ream migrate:status` prints it. */
export interface MigrationStatusNode {
  /** The migration's name, without extension. */
  name: string
  status: MigrationState
  /** The batch it was applied in, when it has been. */
  batch?: number
}

/**
 * What a store's migration runner must provide.
 *
 * Only three methods are REQUIRED — the three `ream migrate`,
 * `migrate:rollback` and `migrate:status` call. Everything else is optional on
 * purpose: a new store must be able to register with a runner that only knows
 * how to go forward, rather than stub methods it cannot honour. A caller that
 * needs an optional one checks for it and says so, instead of crashing.
 */
export interface MigrationRunnerContract {
  /** Apply every pending migration. Resolves to the names applied, in order. */
  migrate(): Promise<string[]>
  /** Undo the last batch. Resolves to the names rolled back. */
  rollback(): Promise<string[]>
  /** Every known migration and whether it has run. */
  status(): Promise<MigrationStatusNode[]>

  /** Undo every migration. */
  reset?(): Promise<string[]>
  /** Reset, then migrate. */
  refresh?(): Promise<unknown>
  /** Drop everything, then migrate. */
  fresh?(): Promise<unknown>
  /** What `migrate()` would do, without doing it. */
  dryRun?(): Promise<unknown>
  /** Release a lock a crashed run left behind. */
  forceUnlock?(): Promise<boolean>
}

/** A registered store, as the CLI sees it. */
export interface RegisteredMigrationSource {
  /**
   * How the store is named on the command line — `atlas`, `eon`, …
   *
   * It is what `ream migrate --only <name>` matches and what prefixes the
   * output, so it belongs to the store, not to the app.
   */
  name: string
  /** Where its migration files live, for the message when there are none. */
  directory?: string
  runner: MigrationRunnerContract
}

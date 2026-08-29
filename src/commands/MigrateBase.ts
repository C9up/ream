/**
 * What `migrate`, `migrate:rollback` and `migrate:status` share.
 *
 * All three drive the SAME thing — the `migrations` registry, where each data
 * package puts its runner — and differ only in which method they call and how
 * they print the result. A ream particularity, deliberate: AdonisJS has one
 * store and can name it, while an application here may hold a relational store
 * and a time-series one at once, so the command names none of them.
 *
 * Sequentially, never in parallel: two stores on one database server would
 * contend on locks, and interleaved output makes a failure impossible to
 * attribute to the store that caused it.
 */

import { BaseCommand } from '../console/BaseCommand.js'
import { flags } from '../console/decorators.js'
import type { CommandOptions } from '../console/types.js'
import type { MigrationRegistry } from '../migrations/MigrationRegistry.js'
import type { RegisteredMigrationSource } from '../migrations/types.js'

export abstract class MigrateBase extends BaseCommand {
  static override options: CommandOptions = { startApp: true }

  @flags.string({
    description: 'Only this migration source, by the name its package registered',
  })
  declare only?: string

  /** What to do with one store. Implemented by each command. */
  protected abstract migrateSource(source: RegisteredMigrationSource): Promise<void>

  async run(): Promise<void> {
    const sources = await this.#resolveSources()
    if (sources === undefined) return

    for (const source of sources) {
      await this.migrateSource(source)
    }
  }

  /** The line every message is prefixed with, so multi-store output stays legible. */
  protected report(source: RegisteredMigrationSource, message: string): void {
    this.logger.log(`  [${source.name}] ${message}`)
  }

  /**
   * The sources this run covers, or `undefined` when the run should stop —
   * having said why.
   *
   * An empty registry is NOT a failure: an application may legitimately have no
   * data package yet. Naming which thing is missing beats exiting non-zero on a
   * state the user may have chosen.
   */
  async #resolveSources(): Promise<RegisteredMigrationSource[] | undefined> {
    const registry = await this.app.container.resolve<MigrationRegistry>('migrations')

    if (this.only !== undefined) {
      const picked = registry.get(this.only)
      if (picked === undefined) {
        const names = registry.names()
        this.logger.error(`No migration source named "${this.only}".`)
        this.logger.error(
          names.length > 0
            ? `  Registered: ${names.join(', ')}`
            : '  No data package registered one. Is its provider in reamrc.ts?',
        )
        this.exitCode = 1
        return undefined
      }
      return [picked]
    }

    const sources = registry.all()
    if (sources.length === 0) {
      this.logger.info('No migration source registered.')
      this.logger.info('  A data package registers one from its provider — check reamrc.ts.')
      return undefined
    }
    return sources
  }
}

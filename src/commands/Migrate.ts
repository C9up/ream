/** `migrate` — apply every pending migration, in every registered store. */

import type { RegisteredMigrationSource } from '../migrations/types.js'
import { MigrateBase } from './MigrateBase.js'

export default class Migrate extends MigrateBase {
  static override commandName = 'migrate'
  static override description = 'Run pending migrations for every registered migration source'

  protected async migrateSource(source: RegisteredMigrationSource): Promise<void> {
    const executed = await source.runner.migrate()
    if (executed.length === 0) {
      this.report(source, 'nothing to migrate.')
      return
    }
    for (const name of executed) this.report(source, `migrated: ${name}`)
  }
}

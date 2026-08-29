/** `migrate:rollback` — undo the last batch, in every registered store. */

import type { RegisteredMigrationSource } from '../migrations/types.js'
import { MigrateBase } from './MigrateBase.js'

export default class MigrateRollback extends MigrateBase {
  static override commandName = 'migrate:rollback'
  static override description = 'Roll back the last batch for every registered migration source'

  protected async migrateSource(source: RegisteredMigrationSource): Promise<void> {
    const rolled = await source.runner.rollback()
    if (rolled.length === 0) {
      this.report(source, 'nothing to rollback.')
      return
    }
    for (const name of rolled) this.report(source, `rolled back: ${name}`)
  }
}

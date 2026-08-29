/** `migrate:status` — what has run and what has not, in every registered store. */

import type { RegisteredMigrationSource } from '../migrations/types.js'
import { MigrateBase } from './MigrateBase.js'

export default class MigrateStatus extends MigrateBase {
  static override commandName = 'migrate:status'
  static override description = 'Show applied and pending migrations for every source'

  protected async migrateSource(source: RegisteredMigrationSource): Promise<void> {
    const statuses = await source.runner.status()
    if (statuses.length === 0) {
      this.report(source, 'no migrations found.')
      return
    }
    for (const node of statuses) {
      const mark = node.status === 'applied' ? '✓' : '○'
      const batch = node.batch === undefined ? '' : ` (batch ${node.batch})`
      this.report(source, `${mark} ${node.name}${batch}`)
    }
  }
}

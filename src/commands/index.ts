/**
 * `@c9up/ream/commands` — the commands the framework itself ships.
 *
 * The shape AdonisJS uses for `@adonisjs/core/commands`: a module answering
 * `getMetaData()` then `getCommand()`, so listing a command does not import it.
 *
 * The kernel registers this loader on its own rather than waiting for an entry
 * in `reamrc.commands` — the deviation from AdonisJS, where the starter kit
 * lists it. These commands were part of the `ream` binary before they were
 * classes, and an application that upgrades must not silently lose them.
 */

import type { CommandClass, SerializedCommand } from '../console/types.js'

interface Entry {
  commandName: string
  description: string
  load: () => Promise<{ default: CommandClass }>
}

const COMMANDS: readonly Entry[] = [
  // The registry commands first: a data package registers its runner, and
  // these drive whatever registered — they name no store.
  {
    commandName: 'migrate',
    description: 'Run pending migrations for every registered migration source',
    load: () => import('./Migrate.js'),
  },
  {
    commandName: 'migrate:rollback',
    description: 'Roll back the last batch for every registered migration source',
    load: () => import('./MigrateRollback.js'),
  },
  {
    commandName: 'migrate:status',
    description: 'Show applied and pending migrations for every source',
    load: () => import('./MigrateStatus.js'),
  },
  {
    commandName: 'schedule:list',
    description: 'List every registered scheduled task, its next run and its stats',
    load: () => import('./ScheduleList.js'),
  },
  {
    commandName: 'schedule:run',
    description: 'Run a registered scheduled task once, now (bypasses the lock)',
    load: () => import('./ScheduleRun.js'),
  },
]

/** `migrate:status` → `migrate`; a name without a colon has no namespace. */
function namespaceOf(commandName: string): string | null {
  const colon = commandName.indexOf(':')
  return colon === -1 ? null : commandName.slice(0, colon)
}

export async function getMetaData(): Promise<SerializedCommand[]> {
  return COMMANDS.map((entry) => ({
    commandName: entry.commandName,
    namespace: namespaceOf(entry.commandName),
    description: entry.description,
    aliases: [],
    options: { startApp: true },
    args: [],
    flags: [],
  }))
}

export async function getCommand(metadata: SerializedCommand): Promise<CommandClass | null> {
  const entry = COMMANDS.find((command) => command.commandName === metadata.commandName)
  if (!entry) return null
  return (await entry.load()).default
}

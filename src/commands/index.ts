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

export async function getMetaData(): Promise<SerializedCommand[]> {
  return COMMANDS.map((entry) => ({
    commandName: entry.commandName,
    namespace: entry.commandName.slice(0, entry.commandName.indexOf(':')),
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

/**
 * The helpers Ace exposes around commands (`@adonisjs/ace` utils).
 *
 * They exist as exports because a custom loader needs them: validating what a
 * module exported, and reporting a name that resolved to nothing.
 */

import { ReamError } from '../errors/ReamError.js'
import type { Logger } from './cliui.js'
import { type CommandClass, isCommandClass, type SerializedCommand } from './types.js'

/** Sort command and namespace names the way the listing does. */
export function sortAlphabetically(prev: string, curr: string): number {
  return prev.localeCompare(curr)
}

/**
 * Report a name that resolved to nothing, with the closest matches.
 *
 * Shared by the kernel's unknown-command report and the `help` command: two
 * wordings for the same dead end is how they end up disagreeing.
 */
export function renderErrorWithSuggestions(
  logger: Logger,
  message: string,
  suggestions: readonly string[],
): void {
  logger.error(message)
  if (suggestions.length === 0) return
  process.stderr.write(`  Did you mean "${suggestions.slice(0, 4).join('", "')}"?\n`)
}

/**
 * Assert that a module's export is a command class.
 *
 * `exportPath` names the file, because the useful part of the message is WHICH
 * module exported the wrong thing.
 */
export function validateCommand(
  command: unknown,
  exportPath: string,
): asserts command is CommandClass {
  if (isCommandClass(command)) return
  throw new ReamError('E_CONSOLE_INVALID_COMMAND', `Invalid command exported from ${exportPath}.`, {
    hint: 'Expected a class with a static commandName, a static description and a run() method.',
  })
}

/** The same, for a metadata object a loader published. */
export function validateCommandMetaData(
  metadata: unknown,
  exportPath: string,
): asserts metadata is SerializedCommand {
  const invalid = (reason: string): never => {
    throw new ReamError(
      'E_CONSOLE_INVALID_COMMAND_METADATA',
      `Invalid command metadata exported from ${exportPath}: ${reason}.`,
    )
  }

  if (typeof metadata !== 'object' || metadata === null) invalid('expected an object')
  const record = metadata as Record<string, unknown>
  if (typeof record.commandName !== 'string' || record.commandName === '') {
    invalid('"commandName" is missing')
  }
  if (typeof record.description !== 'string') invalid('"description" is missing')
  if (!Array.isArray(record.args)) invalid('"args" is missing')
  if (!Array.isArray(record.flags)) invalid('"flags" is missing')
}

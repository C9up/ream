/**
 * `help <command>` — the built-in command explaining another one (Ace's
 * `HelpCommand`).
 *
 * A registered command, not a branch in the dispatcher: `hasCommand('help')` is
 * true, `exec('help', ['make:controller'])` works, and it is replaceable like
 * any other. It reads METADATA, so explaining a command does not import it.
 */

import { BaseCommand } from './BaseCommand.js'
import { args } from './decorators.js'
import { renderErrorWithSuggestions } from './utils.js'

export default class HelpCommand extends BaseCommand {
  static override commandName = 'help'
  static override description = 'View help for a given command'

  @args.string({ argumentName: 'command', description: 'Command name' })
  declare name: string

  run(): void {
    const command = this.kernel.getCommand(this.name)
    if (command === null) {
      // The same report the kernel gives for an unknown command — one dead end,
      // one wording.
      renderErrorWithSuggestions(
        this.logger,
        `Command "${this.name}" is not defined.`,
        this.kernel.getCommandSuggestions(this.name),
      )
      this.exitCode = 1
      return
    }

    this.kernel.printCommandHelp(command)
  }
}

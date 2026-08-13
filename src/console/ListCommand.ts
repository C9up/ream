/**
 * `list` — the built-in command listing every other one (Ace's `ListCommand`).
 *
 * A real registered command rather than a branch inside the kernel: that is
 * what makes `ace.hasCommand('list')` true, `ace.exec('list')` work, and
 * `list --bad` fail the same way any other unknown flag does. A hand-rolled
 * `argv.includes('--json')` inside the dispatcher answers none of those.
 */

import { BaseCommand } from './BaseCommand.js'
import { args, flags } from './decorators.js'

export default class ListCommand extends BaseCommand {
  static override commandName = 'list'
  static override description = 'List all the available commands'
  static override help = [
    'The list command displays a list of all the commands:',
    '  {{ binaryName }} list',
    '',
    'You can also display the commands for a specific namespace:',
    '  {{ binaryName }} list make db',
    '',
    'The list of commands can also be exported as JSON:',
    '  {{ binaryName }} list --json',
  ]

  @args.spread({
    required: false,
    description: 'Only list the commands of these namespaces',
  })
  declare namespaces: string[]

  @flags.boolean({ description: 'Print the full command metadata as JSON' })
  declare json: boolean

  run(): void {
    const namespaces = this.namespaces ?? []

    // Checked per namespace, not on the merged result: with `list make nope`,
    // a single match would otherwise hide the typo.
    const missing = namespaces.filter(
      (namespace) => this.kernel.getNamespaceCommands(namespace).length === 0,
    )
    if (missing.length > 0) {
      this.logger.error(`No command in namespace "${missing.join('", "')}".`)
      // Straight to stderr, like the kernel's unknown-command report: the hint
      // is not part of the listing a caller may be piping.
      process.stderr.write(`  Run "${this.kernel.binaryName} list" to see every command.\n`)
      this.exitCode = 1
      return
    }

    this.kernel.printList(this.json === true, namespaces)
  }
}

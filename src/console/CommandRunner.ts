/**
 * CommandRunner — minimal CLI command framework.
 *
 * Registers commands and dispatches based on argv.
 * Like AdonisJS Ace but lightweight.
 */

export interface Command {
  name: string
  description: string
  run(args: string[], flags: Record<string, string | boolean>): Promise<void>
}

export class CommandRunner {
  private commands: Map<string, Command> = new Map()

  register(command: Command): this {
    this.commands.set(command.name, command)
    return this
  }

  async handle(argv: string[]): Promise<void> {
    const { commandName, args, flags } = parseArgv(argv)

    if (!commandName || commandName === 'help') {
      this.printHelp()
      return
    }

    const command = this.commands.get(commandName)
    if (!command) {
      console.error(`Unknown command: ${commandName}`)
      console.error(`Run without arguments to see available commands.`)
      process.exitCode = 1
      return
    }

    await command.run(args, flags)
  }

  private printHelp(): void {
    console.log('\nAvailable commands:\n')
    for (const [name, cmd] of this.commands) {
      console.log(`  ${name.padEnd(25)} ${cmd.description}`)
    }
    console.log('')
  }

  getCommands(): Map<string, Command> {
    return new Map(this.commands)
  }
}

function parseArgv(argv: string[]): { commandName: string | undefined; args: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        flags[arg.slice(2)] = true
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      flags[arg.slice(1)] = true
    } else {
      positional.push(arg)
    }
  }

  return {
    commandName: positional[0],
    args: positional.slice(1),
    flags,
  }
}

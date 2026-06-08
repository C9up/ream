interface FixtureCommand {
  name: string
  description: string
  run(args: string[], flags: Record<string, string | boolean>): Promise<void>
}

const echoCommand: FixtureCommand = {
  name: 'echo:test',
  description: 'Fixture command — echoes its args (used by Codemods register-roundtrip test).',
  async run(args: string[], _flags: Record<string, string | boolean>): Promise<void> {
    console.log(args.join(' '))
  },
}

export default echoCommand

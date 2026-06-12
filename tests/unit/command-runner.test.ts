import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Command, CommandRunner } from '../../src/console/CommandRunner.js'

function makeCommand(
  name: string,
  onRun?: (args: string[], flags: Record<string, unknown>) => void,
): Command {
  return {
    name,
    description: `the ${name} command`,
    async run(args, flags) {
      onRun?.(args, flags)
    },
  }
}

describe('CommandRunner', () => {
  const originalExitCode = process.exitCode

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
  })

  it('registers commands and exposes a copy via getCommands', () => {
    const runner = new CommandRunner().register(makeCommand('migrate'))
    const cmds = runner.getCommands()
    expect(cmds.has('migrate')).toBe(true)
    // getCommands returns a copy — mutating it doesn't touch the runner.
    cmds.delete('migrate')
    expect(runner.getCommands().has('migrate')).toBe(true)
  })

  it('dispatches to the matching command with positional args and flags', async () => {
    let received: { args: string[]; flags: Record<string, unknown> } | undefined
    const runner = new CommandRunner().register(
      makeCommand('make:controller', (args, flags) => {
        received = { args, flags }
      }),
    )
    await runner.handle(['make:controller', 'Users', '--resource', '--path=app/http'])
    expect(received?.args).toEqual(['Users'])
    expect(received?.flags).toEqual({ resource: true, path: 'app/http' })
  })

  it('parses a short boolean flag', async () => {
    let flags: Record<string, unknown> = {}
    const runner = new CommandRunner().register(
      makeCommand('serve', (_a, f) => {
        flags = f
      }),
    )
    await runner.handle(['serve', '-w'])
    expect(flags).toEqual({ w: true })
  })

  it('sets a non-zero exit code on an unknown command', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = new CommandRunner()
    await runner.handle(['nope'])
    expect(process.exitCode).toBe(1)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Unknown command: nope'))
  })

  it('prints help when no command is given', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const runner = new CommandRunner().register(makeCommand('migrate'))
    await runner.handle([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Available commands'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('migrate'))
  })

  it('treats `help` as the help command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await new CommandRunner().handle(['help'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Available commands'))
  })
})

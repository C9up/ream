import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ace } from '../../src/console/Ace.js'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { args, flags } from '../../src/console/decorators.js'
import { Kernel } from '../../src/console/Kernel.js'
import { Ignitor } from '../../src/Ignitor.js'

const APP_ROOT = new URL('../fixtures/console-app/', import.meta.url)

class Greet extends BaseCommand {
  static override commandName = 'greet'
  static override description = 'Greets someone'

  @args.string()
  declare name: string

  @flags.boolean()
  declare loud: boolean

  run(): string {
    return this.loud ? `HELLO ${this.name.toUpperCase()}` : `hello ${this.name}`
  }
}

class Failing extends BaseCommand {
  static override commandName = 'failing'
  static override description = 'Always throws'
  run(): void {
    throw new Error('boom')
  }
}

function makeAce(...commands: Array<typeof Greet | typeof Failing>): Ace {
  const kernel = new Kernel()
  let loaded = 0
  const ace = new Ace({
    kernel,
    load: async () => {
      loaded++
      for (const command of commands) kernel.register(command)
    },
  })
  Object.assign(ace, { loadCount: () => loaded })
  return ace
}

describe('ace façade', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the command carrying exitCode, result and error', async () => {
    const ace = makeAce(Greet)
    const command = await ace.exec('greet', ['Ada', '--loud'])

    expect(command.result).toBe('HELLO ADA')
    expect(command.exitCode).toBe(0)
    expect(command.error).toBeUndefined()
  })

  it('rejects when the command fails, as Ace does', async () => {
    const ace = makeAce(Failing)

    // The error is recorded on the command AND rethrown: a caller must not be
    // able to mistake a failure for a success by forgetting to look at it.
    await expect(ace.exec('failing')).rejects.toThrow('boom')
    // The process exit code stays untouched — only the command line owns it.
    expect(process.exitCode).toBeUndefined()
  })

  it('answers hasCommand synchronously once booted, as Ace does', async () => {
    const ace = makeAce(Greet)

    // Before boot: an explicit error, not a silent `false` — the registry is
    // empty because nothing was loaded yet, not because the command is missing.
    expect(() => ace.hasCommand('greet')).toThrow(/before the commands were loaded/)

    await ace.boot()
    // Synchronous on purpose: an async version returns a Promise, which is
    // always truthy, so `if (ace.hasCommand(x))` would take every branch.
    expect(ace.hasCommand('greet')).toBe(true)
    expect(ace.hasCommand('nope')).toBe(false)
    expect(ace.getCommands().map((command) => command.commandName)).toContain('greet')

    await expect(ace.exec('nope')).rejects.toThrow(/Unknown command "nope"/)
  })

  it('loads the commands once, even under concurrent calls', async () => {
    const ace = makeAce(Greet)
    const loadCount = Reflect.get(ace, 'loadCount') as () => number

    await Promise.all([ace.boot(), ace.boot(), ace.boot()])
    await ace.exec('greet', ['Ada'])

    expect(loadCount()).toBe(1)
  })

  it('is reachable from a booted application and sees the discovered commands', async () => {
    const ignitor = new Ignitor(APP_ROOT)
    const ace = await ignitor.ace()
    await ace.boot()

    expect(ace.hasCommand('greet')).toBe(true)
    expect(ace.hasCommand('deep:command')).toBe(true)

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const command = await ace.exec('greet', ['World'])
    stdout.mockRestore()

    expect(command.exitCode).toBe(0)

    // The container binding is the other documented way in.
    const resolved = await ignitor.getApp().container.resolve('ace')
    expect(resolved).toBe(ace)
  })
})

describe('ace service locator', () => {
  it('is usable right after the application boots', async () => {
    const ignitor = new Ignitor(APP_ROOT)
    await ignitor.start()

    // Ace documents the service as available once the app has booted — a bare
    // import must not throw in a running application.
    const { default: ace } = await import('../../src/services/ace.js')
    await ace.boot()
    expect(ace.hasCommand('greet')).toBe(true)

    await ignitor.stop()
  })
})

describe('ace façade — completed() failures', () => {
  it('surfaces a throw from completed(), after run() produced its result', async () => {
    let produced: string | undefined
    class BadCleanup extends BaseCommand {
      static override commandName = 'bad-cleanup'
      static override description = 'Its cleanup throws'
      run(): string {
        produced = 'ran'
        return produced
      }
      override completed(): void {
        throw new Error('cleanup failed')
      }
    }

    const kernel = new Kernel()
    kernel.register(BadCleanup)
    const ace = new Ace({ kernel, load: async () => {} })

    // `completed` is part of the lifecycle the KERNEL drives — the command's
    // own `exec()` runs `run()` alone — so a throw there is an execution
    // failure, and it surfaces like any other one.
    await expect(ace.exec('bad-cleanup')).rejects.toThrow('cleanup failed')
    expect(produced).toBe('ran')
  })

  it('keeps the original failure as the cause when cleanup fails too', async () => {
    class BothFail extends BaseCommand {
      static override commandName = 'both-fail'
      static override description = 'run and completed both throw'
      run(): void {
        throw new Error('run failed')
      }
      override completed(): void {
        throw new Error('cleanup failed')
      }
    }

    const kernel = new Kernel()
    kernel.register(BothFail)
    const ace = new Ace({ kernel, load: async () => {} })

    const failure = await ace.exec('both-fail').catch((error: unknown) => error)
    expect(String(failure)).toContain('cleanup failed')
    // The first failure is the interesting one — it must not be swallowed.
    expect(String((failure as Error).cause)).toContain('run failed')
  })
})

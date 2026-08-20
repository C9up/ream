import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Console } from '../../src/console/Console.js'
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

function makeConsole(...commands: Array<typeof Greet | typeof Failing>): Console {
  const kernel = new Kernel()
  let loaded = 0
  const consoleApp = new Console({
    kernel,
    load: async () => {
      loaded++
      for (const command of commands) kernel.register(command)
    },
  })
  Object.assign(consoleApp, { loadCount: () => loaded })
  return consoleApp
}

describe('consoleApp façade', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the command carrying exitCode, result and error', async () => {
    const consoleApp = makeConsole(Greet)
    const command = await consoleApp.exec('greet', ['Ada', '--loud'])

    expect(command.result).toBe('HELLO ADA')
    expect(command.exitCode).toBe(0)
    expect(command.error).toBeUndefined()
  })

  it('rejects when the command fails, as Console does', async () => {
    const consoleApp = makeConsole(Failing)

    // The error is recorded on the command AND rethrown: a caller must not be
    // able to mistake a failure for a success by forgetting to look at it.
    await expect(consoleApp.exec('failing')).rejects.toThrow('boom')
    // The process exit code stays untouched — only the command line owns it.
    expect(process.exitCode).toBeUndefined()
  })

  it('answers hasCommand synchronously once booted, as Console does', async () => {
    const consoleApp = makeConsole(Greet)

    // Before boot: an explicit error, not a silent `false` — the registry is
    // empty because nothing was loaded yet, not because the command is missing.
    expect(() => consoleApp.hasCommand('greet')).toThrow(/before the commands were loaded/)

    await consoleApp.boot()
    // Synchronous on purpose: an async version returns a Promise, which is
    // always truthy, so `if (consoleApp.hasCommand(x))` would take every branch.
    expect(consoleApp.hasCommand('greet')).toBe(true)
    expect(consoleApp.hasCommand('nope')).toBe(false)
    expect(consoleApp.getCommands().map((command) => command.commandName)).toContain('greet')

    await expect(consoleApp.exec('nope')).rejects.toThrow(/Unknown command "nope"/)
  })

  it('loads the commands once, even under concurrent calls', async () => {
    const consoleApp = makeConsole(Greet)
    const loadCount = Reflect.get(consoleApp, 'loadCount') as () => number

    await Promise.all([consoleApp.boot(), consoleApp.boot(), consoleApp.boot()])
    await consoleApp.exec('greet', ['Ada'])

    expect(loadCount()).toBe(1)
  })

  it('is reachable from a booted application and sees the discovered commands', async () => {
    const ignitor = new Ignitor(APP_ROOT)
    const consoleApp = await ignitor.consoleApp()
    await consoleApp.boot()

    expect(consoleApp.hasCommand('greet')).toBe(true)
    expect(consoleApp.hasCommand('deep:command')).toBe(true)

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const command = await consoleApp.exec('greet', ['World'])
    stdout.mockRestore()

    expect(command.exitCode).toBe(0)

    // The container binding is the other documented way in.
    const resolved = await ignitor.getApp().container.resolve('console')
    expect(resolved).toBe(consoleApp)
  })
})

describe('consoleApp service locator', () => {
  it('is usable right after the application boots', async () => {
    const ignitor = new Ignitor(APP_ROOT)
    await ignitor.start()

    // Console documents the service as available once the app has booted — a bare
    // import must not throw in a running application.
    const { default: consoleApp } = await import('../../src/services/console.js')
    await consoleApp.boot()
    expect(consoleApp.hasCommand('greet')).toBe(true)

    await ignitor.stop()
  })
})

describe('consoleApp façade — completed() failures', () => {
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
    const consoleApp = new Console({ kernel, load: async () => {} })

    // `completed` is part of the lifecycle the KERNEL drives — the command's
    // own `exec()` runs `run()` alone — so a throw there is an execution
    // failure, and it surfaces like any other one.
    await expect(consoleApp.exec('bad-cleanup')).rejects.toThrow('cleanup failed')
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
    const consoleApp = new Console({ kernel, load: async () => {} })

    const failure = await consoleApp.exec('both-fail').catch((error: unknown) => error)
    expect(String(failure)).toContain('cleanup failed')
    // The first failure is the interesting one — it must not be swallowed.
    expect(String((failure as Error).cause)).toContain('run failed')
  })
})

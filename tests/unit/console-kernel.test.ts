import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '../../src/Application.js'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { Ui } from '../../src/console/cliui.js'
import { args, flags } from '../../src/console/decorators.js'
import { ExceptionHandler } from '../../src/console/ExceptionHandler.js'
import { Kernel } from '../../src/console/Kernel.js'
import { FsLoader, ListLoader } from '../../src/console/loaders.js'
import type { CommandClass, CommandInstance, ParsedInput } from '../../src/console/types.js'

/** Captures everything written to stdout/stderr during one dispatch. */
function captureOutput(): { out: () => string; restore: () => void } {
  let buffer = ''
  const write = (chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(write)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(write)
  return {
    out: () => buffer,
    restore: () => {
      stdout.mockRestore()
      stderr.mockRestore()
    },
  }
}

/**
 * A kernel whose failures are captured instead of printed.
 *
 * `handle()` REPORTS a failure through `errorHandler` — the command line owns
 * the process, so there is nobody to throw at. Replacing the renderer is how a
 * test reads the error, and it is the same seam an application would use.
 */
function kernelCapturing(...commands: CommandClass[]): {
  kernel: Kernel
  failure: () => unknown
} {
  let captured: unknown
  const kernel = new Kernel().registerMany(commands)
  kernel.errorHandler = {
    render(error: unknown): void {
      captured = error
    },
  }
  return { kernel, failure: () => captured }
}

const ran: string[] = []

class Provision extends BaseCommand {
  static override commandName = 'provision'
  static override description = 'Create the owner account'

  @flags.string({ required: true, description: 'Owner email' })
  declare email: string

  @flags.string({ default: 'Owner' })
  declare name: string

  run(): void {
    ran.push(`${this.email}|${this.name}`)
  }
}

class MakeController extends BaseCommand {
  static override commandName = 'make:controller'
  static override description = 'Generate a controller'

  @args.string()
  declare name: string

  @flags.boolean({ alias: 'r' })
  declare resource: boolean

  run(): void {
    ran.push(`${this.name}|${String(this.resource)}`)
  }
}

describe('Kernel', () => {
  const originalExitCode = process.exitCode

  beforeEach(() => {
    ran.length = 0
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
  })

  it('hydrates the command with parsed args and flags', async () => {
    const kernel = new Kernel().register(Provision)
    await kernel.handle(['provision', '--email', 'hugo@finefoxy.ch'])
    expect(ran).toEqual(['hugo@finefoxy.ch|Owner'])
  })

  it('hydrates positional arguments and aliases', async () => {
    const kernel = new Kernel().register(MakeController)
    await kernel.handle(['make:controller', 'Users', '-r'])
    expect(ran).toEqual(['Users|true'])
  })

  it('exposes command metadata rather than the classes themselves', () => {
    const kernel = new Kernel().register(Provision)
    const provision = kernel.getCommand('provision')

    // Metadata, as Console does: a caller introspecting the registry must not be
    // handed a constructor it could instantiate outside the kernel.
    expect(provision?.commandName).toBe('provision')
    expect(provision?.namespace).toBeNull()
    expect(provision?.flags.map((flag) => flag.flagName)).toEqual(['email', 'name'])
  })

  it('carries the aliases declared in the rc file into the metadata', () => {
    const kernel = new Kernel().register(Provision).addAlias('setup', 'provision')
    expect(kernel.getCommand('provision')?.aliases).toEqual(['setup'])
    expect(kernel.getAliases()).toEqual(['setup'])
    expect(kernel.getAliasCommand('setup')?.commandName).toBe('provision')
  })

  it('rejects two commands claiming the same name', () => {
    class Other extends BaseCommand {
      static override commandName = 'provision'
      static override description = 'Impostor'
      run(): void {}
    }
    const kernel = new Kernel().register(Provision)
    expect(() => kernel.register(Other)).toThrow(/Two commands claim the name/)
  })

  it('propagates a command exit code', async () => {
    class Failing extends BaseCommand {
      static override commandName = 'failing'
      static override description = 'Sets an exit code'
      run(): void {
        this.exitCode = 3
      }
    }
    await new Kernel().register(Failing).handle(['failing'])
    expect(process.exitCode).toBe(3)
  })

  it('suggests the closest command and exits non-zero on an unknown one', async () => {
    const captured = captureOutput()
    await new Kernel().register(Provision).handle(['provisio'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('Unknown command "provisio"')
    expect(output).toContain('Did you mean "provision"?')
    expect(process.exitCode).toBe(1)
  })

  it('lists commands grouped by namespace', async () => {
    const captured = captureOutput()
    await new Kernel().registerMany([Provision, MakeController]).handle(['list'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('provision')
    expect(output).toContain('make:controller')
    expect(output).toContain('Create the owner account')
  })

  it('lists commands as JSON on demand', async () => {
    const captured = captureOutput()
    await new Kernel().register(Provision).handle(['list', '--json'])
    const output = captured.out()
    captured.restore()

    // The full metadata contract — tooling builds help, completions or a
    // command palette from this, so a three-field summary is not enough.
    const entry = JSON.parse(output).find(
      (command: { commandName: string }) => command.commandName === 'provision',
    )
    expect(entry).toMatchObject({
      commandName: 'provision',
      namespace: null,
      description: 'Create the owner account',
      aliases: [],
    })
    expect(entry.flags.map((flag: { flagName: string }) => flag.flagName)).toEqual([
      'email',
      'name',
    ])
    // No function survives JSON, so `parse` must not be advertised here.
    expect('parse' in entry.flags[0]).toBe(false)
  })

  it('lists the metadata by name, not in registration order', () => {
    class Zulu extends BaseCommand {
      static override commandName = 'alpha'
      static override description = 'Registered last, sorted first'
      run(): void {}
    }

    const kernel = new Kernel().registerMany([Provision, MakeController, Zulu])
    expect(kernel.getCommands().map((command) => command.commandName)).toEqual([
      'alpha',
      'help',
      'list',
      'make:controller',
      'provision',
    ])
  })

  it('exposes the namespaces, their commands and near-miss suggestions', () => {
    const kernel = new Kernel().registerMany([Provision, MakeController])

    expect(kernel.getNamespaces()).toEqual(['make'])
    expect(kernel.getNamespaceCommands('make').map((c) => c.commandName)).toEqual([
      'make:controller',
    ])
    // No namespace given: the commands that have none, not all of them.
    expect(kernel.getNamespaceCommands().map((c) => c.commandName)).toEqual([
      'help',
      'list',
      'provision',
    ])
    expect(kernel.getCommandSuggestions('provisio')).toContain('provision')
    expect(kernel.getNamespaceSuggestions('mak')).toEqual(['make'])
    expect(kernel.getCommandSuggestions('zzzzzzzz')).toEqual([])
  })

  it('prints what the CLI says about itself above the listing', async () => {
    const kernel = new Kernel().register(Provision)
    kernel.info.set('binary', 'ream')
    kernel.info.set('Framework version', '0.1.13')

    const captured = captureOutput()
    await kernel.handle(['list'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('Framework version')
    expect(output).toContain('0.1.13')
  })

  it('narrows the list to the requested namespaces', async () => {
    const captured = captureOutput()
    await new Kernel().registerMany([Provision, MakeController]).handle(['list', 'make'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('make:controller')
    expect(output).not.toContain('provision')
  })

  it('filters the JSON listing by namespace too', async () => {
    const captured = captureOutput()
    await new Kernel().registerMany([Provision, MakeController]).handle(['list', 'make', '--json'])
    const output = captured.out()
    captured.restore()

    expect(JSON.parse(output).map((entry: { commandName: string }) => entry.commandName)).toEqual([
      'make:controller',
    ])
  })

  it('reports an unknown namespace instead of printing an empty list', async () => {
    const captured = captureOutput()
    await new Kernel().registerMany([Provision, MakeController]).handle(['list', 'mak'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('No command in namespace "mak"')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('dispatches `list` as a real command, not a branch in the dispatcher', async () => {
    const kernel = new Kernel().register(Provision)

    // The three things a hand-rolled `argv.includes('--json')` cannot answer.
    expect(kernel.hasCommand('list')).toBe(true)
    expect(kernel.getCommand('list')?.description).toBeTypeOf('string')

    const captured = captureOutput()
    const command = await kernel.exec('list', ['--json'])
    const output = captured.out()
    captured.restore()

    expect(command.exitCode).toBe(0)
    expect(JSON.parse(output).map((entry: { commandName: string }) => entry.commandName)).toEqual([
      'help',
      'list',
      'provision',
    ])
  })

  it("lets the application's own `list` replace the built-in one", async () => {
    let ran = false
    class AppList extends BaseCommand {
      static override commandName = 'list'
      static override description = "The app's own listing"
      run(): void {
        ran = true
      }
    }

    // One registry, and the application wins — the same rule the CLI applies
    // to the built-in commands an app shadows.
    const kernel = new Kernel().register(AppList)
    expect(kernel.getCommand('list')?.description).toBe("The app's own listing")

    await kernel.handle([])
    expect(ran).toBe(true)
  })

  it('still rejects two application commands claiming one name', () => {
    class First extends BaseCommand {
      static override commandName = 'report'
      static override description = 'First'
      run(): void {}
    }
    class Second extends BaseCommand {
      static override commandName = 'report'
      static override description = 'Second'
      run(): void {}
    }

    // Replaceable applies to the kernel's OWN defaults, not to a name the app
    // has already taken: there is nothing to arbitrate between those two.
    expect(() => new Kernel().register(First).register(Second)).toThrow(
      /Two commands claim the name "report"/,
    )
  })

  it('validates the flags of `list` like any other command', async () => {
    const captured = captureOutput()
    // Before `list` was a command it went through a private mini-parser, which
    // swallowed anything it did not recognise.
    const { kernel, failure } = kernelCapturing()
    await kernel.handle(['list', '--bad'])
    expect(String(failure())).toMatch(/--bad/)
    captured.restore()
  })

  it('answers `help list` with the help of list itself', async () => {
    const captured = captureOutput()
    await new Kernel().register(Provision).handle(['help', 'list'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('ream list')
    expect(output).toContain('--json')
    // The general listing, which is what `help list` used to fall back to.
    expect(output).not.toContain('Create the owner account')
  })

  it('runs the default command when called with no argument', async () => {
    const captured = captureOutput()
    await new Kernel().register(Provision).handle([])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('provision')
  })

  it('dispatches `help` as a real command too', async () => {
    const kernel = new Kernel().register(Provision)

    expect(kernel.hasCommand('help')).toBe(true)

    const captured = captureOutput()
    await kernel.handle(['help', 'provision'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('ream provision')
    expect(output).toContain('--email')
    expect(output).toContain('Owner email')
    expect(ran).toEqual([])
  })

  it('suggests a near miss when help names an unknown command', async () => {
    const captured = captureOutput()
    const kernel = new Kernel().register(Provision)
    await kernel.handle(['help', 'provisio'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('Command "provisio" is not defined')
    expect(output).toContain('Did you mean "provision"?')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('answers --help even when the command declares required inputs', async () => {
    const captured = captureOutput()
    // The order Console uses: parse, run the flag listeners, THEN validate. Checking
    // the required flag first would make `--help` unusable on the very commands
    // whose help one needs most.
    await new Kernel().register(Provision).handle(['provision', '--help'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('--email')
    expect(output).not.toContain('Missing required flag')
    expect(ran).toEqual([])
  })

  it('prints per-command help instead of running it', async () => {
    const captured = captureOutput()
    await new Kernel().register(Provision).handle(['provision', '--help'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('provision')
    expect(output).toContain('--email')
    expect(output).toContain('Owner email')
    expect(output).toContain('required')
    expect(ran).toEqual([])
  })

  it('does not boot the application for a command that did not ask', async () => {
    const startApp = vi.fn()
    class Touches extends BaseCommand {
      static override commandName = 'touches'
      static override description = 'Reads this.app without declaring startApp'
      run(): void {
        void this.app
      }
    }

    let failure: unknown
    const kernel = new Kernel({ startApp }).register(Touches)
    kernel.errorHandler = {
      render(error: unknown): void {
        failure = error
      },
    }
    await kernel.handle(['touches'])
    expect(String(failure)).toMatch(/without booting the application/)
    expect(startApp).not.toHaveBeenCalled()
  })

  it('boots the application for a command that declares startApp', async () => {
    // A real Application: the kernel hands it to the command untouched, so
    // there is nothing to fake here.
    const application = new Application()
    application.container.singleton('marker', () => 'booted')
    const startApp = vi.fn(async () => application)

    class Needs extends BaseCommand {
      static override commandName = 'needs'
      static override description = 'Needs the container'
      static override options = { startApp: true }
      async run(): Promise<void> {
        ran.push(String(await this.app.container.resolve('marker')))
      }
    }

    await new Kernel({ startApp }).register(Needs).handle(['needs'])
    expect(startApp).toHaveBeenCalledTimes(1)
    expect(ran).toEqual(['booted'])
  })

  it('tells the boot not to migrate before starting a command that migrates', async () => {
    // atlas migrates on boot outside production, for the convenience of `dev`.
    // For the commands that exist to migrate, that convenience is the bug: the
    // boot applies everything, so `migrate` reports nothing to do and
    // `migrate:status` has changed the schema it was asked to look at. The flag
    // has to be set BEFORE the application starts, which is the only reason it
    // lives in the kernel rather than in the command.
    const previous = process.env.REAM_SKIP_BOOT_MIGRATE
    delete process.env.REAM_SKIP_BOOT_MIGRATE
    const seen: Array<string | undefined> = []
    const startApp = vi.fn(async () => {
      seen.push(process.env.REAM_SKIP_BOOT_MIGRATE)
      return new Application()
    })

    class Migrates extends BaseCommand {
      static override commandName = 'migrates'
      static override description = 'Drives the migrations itself'
      static override options = { startApp: true, drivesMigrations: true }
      run(): void {}
    }

    await new Kernel({ startApp }).register(Migrates).handle(['migrates'])
    expect(seen).toEqual(['1'])

    if (previous === undefined) delete process.env.REAM_SKIP_BOOT_MIGRATE
    else process.env.REAM_SKIP_BOOT_MIGRATE = previous
  })

  it('leaves the boot migration alone for a command that does not drive it', async () => {
    const previous = process.env.REAM_SKIP_BOOT_MIGRATE
    delete process.env.REAM_SKIP_BOOT_MIGRATE
    const seen: Array<string | undefined> = []
    const startApp = vi.fn(async () => {
      seen.push(process.env.REAM_SKIP_BOOT_MIGRATE)
      return new Application()
    })

    class Seeds extends BaseCommand {
      static override commandName = 'seeds'
      static override description = 'Wants a migrated schema'
      static override options = { startApp: true }
      run(): void {}
    }

    await new Kernel({ startApp }).register(Seeds).handle(['seeds'])
    expect(seen).toEqual([undefined])

    if (previous === undefined) delete process.env.REAM_SKIP_BOOT_MIGRATE
    else process.env.REAM_SKIP_BOOT_MIGRATE = previous
  })

  it('reports when a command needs an app the kernel cannot provide', async () => {
    class Needs extends BaseCommand {
      static override commandName = 'needs'
      static override description = 'Needs the container'
      static override options = { startApp: true }
      run(): void {}
    }
    const { kernel: needsKernel, failure: needsFailure } = kernelCapturing(Needs)
    await needsKernel.handle(['needs'])
    expect(String(needsFailure())).toMatch(/requires a booted application/)
  })

  it('reports a command that wants to stay alive', async () => {
    class Worker extends BaseCommand {
      static override commandName = 'worker'
      static override description = 'Long running'
      static override options = { staysAlive: true }
      run(): void {}
    }
    const result = await new Kernel().register(Worker).handle(['worker'])
    expect(result.staysAlive).toBe(true)
  })

  it('registers a module default export and rejects anything else', () => {
    const kernel = new Kernel()
    expect(kernel.registerModule({ default: Provision })).toBe(true)
    expect(kernel.registerModule({ default: { name: 'legacy', run: () => {} } })).toBe(false)
    expect(kernel.registerModule({ notDefault: Provision })).toBe(false)
    expect(kernel.registerModule(null)).toBe(false)
  })
})

describe('Kernel — Console lifecycle and contracts', () => {
  const originalExitCode = process.exitCode

  afterEach(() => {
    process.exitCode = originalExitCode
    delete process.env.NO_COLOR
    delete process.env.FORCE_COLOR
    vi.restoreAllMocks()
  })

  it('runs prepare, interact, run and completed in Console order', async () => {
    const order: string[] = []
    class Staged extends BaseCommand {
      static override commandName = 'staged'
      static override description = 'Records its lifecycle'
      override async prepare(): Promise<void> {
        order.push('prepare')
      }
      override async interact(): Promise<void> {
        order.push('interact')
      }
      async run(): Promise<void> {
        order.push('run')
      }
      override async completed(): Promise<void> {
        order.push('completed')
      }
    }

    await new Kernel().register(Staged).handle(['staged'])
    expect(order).toEqual(['prepare', 'interact', 'run', 'completed'])
  })

  it('runs completed() after a failure and lets it swallow the error', async () => {
    class Failing extends BaseCommand {
      static override commandName = 'failing'
      static override description = 'Throws, then handles it'
      seen: unknown
      run(): void {
        throw new Error('boom')
      }
      override completed(): boolean {
        this.seen = this.error
        return true // handled
      }
    }
    await expect(new Kernel().register(Failing).handle(['failing'])).resolves.toBeDefined()

    class Unhandled extends BaseCommand {
      static override commandName = 'unhandled'
      static override description = 'Throws and does not handle it'
      run(): void {
        throw new Error('boom')
      }
      override completed(): void {}
    }
    const { kernel, failure } = kernelCapturing(Unhandled)
    await kernel.handle(['unhandled'])
    expect(String(failure())).toContain('boom')
  })

  it('exposes every parsed input on this.parsed', async () => {
    let parsed: unknown
    class Inspect extends BaseCommand {
      static override commandName = 'inspect'
      static override description = 'Reads this.parsed'

      @args.string()
      declare name: string

      @flags.boolean()
      declare force: boolean

      run(): void {
        parsed = this.parsed
      }
    }

    await new Kernel().register(Inspect).handle(['inspect', 'Ada', '--force'])
    // Console's shape: positionals as a LIST, flags under their COMMAND-LINE name.
    expect(parsed).toEqual({
      args: ['Ada'],
      flags: { force: true },
      unknownFlags: [],
      extraArgs: [],
      _: [],
      nodeArgs: [],
    })
  })

  it('applies the parse() callback of args and flags', async () => {
    let seen: { name: string; retries: number } | undefined
    class Parsed extends BaseCommand {
      static override commandName = 'parsed'
      static override description = 'Transforms its inputs'

      @args.string({ parse: (value) => String(value).toUpperCase() })
      declare name: string

      @flags.number({ parse: (value) => Number(value) * 2 })
      declare retries: number

      run(): void {
        seen = { name: this.name, retries: this.retries }
      }
    }

    await new Kernel().register(Parsed).handle(['parsed', 'ada', '--retries', '3'])
    expect(seen).toEqual({ name: 'ADA', retries: 6 })
  })

  it('expands a registered alias, flags included', async () => {
    let seen: { name: string; resource: boolean } | undefined
    class MakeController extends BaseCommand {
      static override commandName = 'make:controller'
      static override description = 'Generates a controller'

      @args.string()
      declare name: string

      @flags.boolean()
      declare resource: boolean

      run(): void {
        seen = { name: this.name, resource: this.resource }
      }
    }

    const kernel = new Kernel()
      .register(MakeController)
      .addAlias('resource', 'make:controller --resource')

    await kernel.handle(['resource', 'users'])
    expect(seen).toEqual({ name: 'users', resource: true })
  })

  it('honours --ansi / --no-ansi without leaking them into the command', async () => {
    let flags: unknown
    class Plain extends BaseCommand {
      static override commandName = 'plain'
      static override description = 'Declares no flags'
      run(): void {
        flags = this.parsed.flags
      }
    }

    // A command declaring no flags still accepts them: they are GLOBAL, so the
    // parser knows them and does not report them as unknown.
    const kernel = new Kernel().register(Plain)
    await kernel.handle(['plain', '--no-ansi'])
    expect(process.env.NO_COLOR).toBe('1')
    // Visible in the parsed input, as in Console — but never assigned to the
    // command, which did not declare them.
    expect(flags).toEqual({ ansi: false })

    await new Kernel().register(Plain).handle(['plain', '--ansi'])
    expect(process.env.FORCE_COLOR).toBe('1')
    expect(process.env.NO_COLOR).toBeUndefined()
    expect(kernel.flags.map((flag) => flag.flagName)).toEqual(['help', 'ansi'])
  })

  it('accepts a global flag written before the command name', async () => {
    let seen: unknown
    class Plain extends BaseCommand {
      static override commandName = 'plain'
      static override description = 'Declares no flags'
      run(): void {
        seen = this.parsed.flags
      }
    }

    // Where a user naturally puts a CLI-wide switch. The command name still has
    // to be the first token for the registry lookup, so the flag is moved.
    await new Kernel().register(Plain).handle(['--no-ansi', 'plain'])
    expect(seen).toEqual({ ansi: false })
    expect(process.env.NO_COLOR).toBe('1')
    delete process.env.NO_COLOR
  })

  it('lets a global flag listener declare its own flag and stop the dispatch', async () => {
    let ran = false
    class Deploy extends BaseCommand {
      static override commandName = 'deploy'
      static override description = 'Deploys'
      run(): void {
        ran = true
      }
    }

    const build = (): Kernel => {
      const kernel = new Kernel().register(Deploy)
      kernel.defineFlag('dry-run', { type: 'boolean', description: 'Explain, do not act' })
      kernel.on('dry-run', () => true)
      return kernel
    }

    // Returning true ends the dispatch before the command is even built — how
    // Console short-circuits on --help. One kernel drives one command line, so the
    // comparison runs on a second one.
    await build().handle(['deploy', '--dry-run'])
    expect(ran).toBe(false)

    await build().handle(['deploy'])
    expect(ran).toBe(true)
  })

  it('loads its commands from the loaders it was given', async () => {
    const kernel = Kernel.create()
    kernel.addLoader({
      getMetaData: async () => [Provision.serialize()],
      getCommand: async (metadata) => (metadata.commandName === 'provision' ? Provision : null),
    })

    expect(kernel.getState()).toBe('idle')
    expect(kernel.hasCommand('provision')).toBe(false)

    await kernel.boot()
    expect(kernel.getState()).toBe('booted')
    expect(kernel.hasCommand('provision')).toBe(true)
    // Idempotent: a second boot must not re-register anything.
    await kernel.boot()
    expect(kernel.getCommands().filter((c) => c.commandName === 'provision')).toHaveLength(1)
  })

  it('reports a call error as one line, and an unexpected one in full', async () => {
    class Boom extends BaseCommand {
      static override commandName = 'boom'
      static override description = 'Throws something nobody expected'
      run(): never {
        throw new Error('kaboom')
      }
    }

    const printed: unknown[] = []
    const kernel = new Kernel().register(Provision).register(Boom)
    const handler = new ExceptionHandler()
    // The seam the class exists for: reporting stays the framework's, the
    // output is ours.
    Object.assign(handler, { prettyPrintError: (error: unknown) => printed.push(error) })
    kernel.errorHandler = handler

    const captured = captureOutput()
    await kernel.handle(['provision'])
    const output = captured.out()
    captured.restore()

    // A missing flag is something the user typed: one line, no stack.
    expect(output).toContain('Missing required flag "--email"')
    expect(printed).toEqual([])

    const second = new Kernel().register(Boom)
    second.errorHandler = handler
    await second.handle(['boom'])
    // An unexpected throw is a developer's problem: everything is printed.
    expect(printed).toHaveLength(1)
    process.exitCode = 0
  })

  it('loads commands given as a list (ListLoader)', async () => {
    const kernel = new Kernel()
    kernel.addLoader(new ListLoader([Provision, MakeController]))

    await kernel.boot()
    expect(kernel.hasCommand('provision')).toBe(true)
    expect((await kernel.find('make:controller')).commandName).toBe('make:controller')
  })

  it('loads commands from a directory (FsLoader)', async () => {
    const kernel = new Kernel()
    const skipped: string[] = []
    // The fixtures the discovery tests use: two commands and one broken file.
    kernel.addLoader(
      new FsLoader(new URL('../fixtures/console-app/commands/', import.meta.url)).onSkipped(
        (fileName) => skipped.push(fileName),
      ),
    )

    await kernel.boot()
    expect(kernel.getCommands().map((command) => command.commandName)).toContain('greet')
    expect(skipped).toEqual(['broken.ts'])
  })

  it('accepts a loader given as a function, resolved at boot', async () => {
    const kernel = new Kernel()
    kernel.addLoader(async () => ({
      getMetaData: async () => [Provision.serialize()],
      getCommand: async () => Provision,
    }))

    await kernel.boot()
    expect(kernel.hasCommand('provision')).toBe(true)
  })

  it('runs the lifecycle hooks around finding and executing a command', async () => {
    const seen: string[] = []
    const kernel = new Kernel().register(Provision)
    // The execution hooks carry the INSTANCE, whose type is the structural
    // contract — the name lives on its class.
    const nameOf = (command: object): string =>
      String(Reflect.get(command.constructor, 'commandName'))

    kernel.finding((name) => {
      seen.push(`finding:${name}`)
    })
    kernel.loading((metadata) => {
      seen.push(`loading:${metadata.commandName}`)
    })
    kernel.loaded((command) => {
      seen.push(`loaded:${command.commandName}`)
    })
    kernel.executing((command, isMain) => {
      seen.push(`executing:${nameOf(command)}:${isMain}`)
    })
    kernel.executed((command, isMain) => {
      seen.push(`executed:${nameOf(command)}:${isMain}`)
    })

    await kernel.exec('provision', ['--email', 'ada@example.ch'])

    expect(seen).toEqual([
      'finding:provision',
      'loading:provision',
      'loaded:provision',
      'executing:provision:false',
      'executed:provision:false',
    ])
  })

  it('skips the executed hook when the command failed', async () => {
    const seen: string[] = []
    class Fails extends BaseCommand {
      static override commandName = 'fails'
      static override description = 'Throws'
      run(): never {
        throw new Error('boom')
      }
    }

    const { kernel, failure } = kernelCapturing(Fails)
    kernel.executing(() => {
      seen.push('executing')
    })
    kernel.executed(() => {
      seen.push('executed')
    })

    await kernel.handle(['fails'])
    // Console runs `executed` after the executor RETURNS, so a throw skips it — a
    // hook counting completions must not see a failure.
    expect(seen).toEqual(['executing'])
    expect(String(failure())).toContain('boom')
    process.exitCode = 0
  })

  it('runs the default command through find(), hooks and all', async () => {
    const seen: string[] = []
    const kernel = new Kernel().register(Provision)
    kernel.finding((name) => {
      seen.push(name)
    })

    // `ream` bare and `ream <command>` must run the same cycle.
    await kernel.handle([])
    expect(seen).toEqual(['list'])
  })

  it('runs the same hooks for the command line, not only for exec()', async () => {
    const seen: string[] = []
    const kernel = new Kernel().register(Provision)
    kernel.finding((name) => {
      seen.push(`finding:${name}`)
    })
    kernel.loaded((command) => {
      seen.push(`loaded:${command.commandName}`)
    })
    kernel.executing((_command, isMain) => {
      seen.push(`executing:${isMain}`)
    })

    // A tool listening to these must see `ream <cmd>` too — the CLI path goes
    // through find(), like Console's.
    await kernel.handle(['provision', '--email', 'ada@example.ch'])
    expect(seen).toEqual(['finding:provision', 'loaded:provision', 'executing:true'])
  })

  it('does not import a command nobody asked for', async () => {
    let imported = 0
    const kernel = new Kernel()
    kernel.addLoader({
      getMetaData: async () => [Provision.serialize(), MakeController.serialize()],
      getCommand: async (metadata) => {
        imported++
        return metadata.commandName === 'provision' ? Provision : MakeController
      },
    })

    await kernel.boot()
    // Booting reads metadata. Listing, describing and answering hasCommand()
    // all work off it — importing a module here would run the side effects of
    // commands nobody is going to execute.
    expect(imported).toBe(0)
    expect(kernel.hasCommand('provision')).toBe(true)
    expect(kernel.getCommands().map((command) => command.commandName)).toEqual([
      'help',
      'list',
      'make:controller',
      'provision',
    ])
    expect(kernel.getCommand('make:controller')?.description).toBe('Generate a controller')
    expect(kernel.getNamespaces()).toEqual(['make'])
    expect(imported).toBe(0)

    // Asked for: imported, once.
    await kernel.find('provision')
    expect(imported).toBe(1)
    await kernel.find('provision')
    expect(imported).toBe(1)
  })

  it('lists the announced commands without importing them', async () => {
    let imported = 0
    const kernel = new Kernel()
    kernel.addLoader({
      getMetaData: async () => [Provision.serialize()],
      getCommand: async () => {
        imported++
        return Provision
      },
    })

    const captured = captureOutput()
    await kernel.handle(['list'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('provision')
    expect(output).toContain('Create the owner account')
    expect(imported).toBe(0)
  })

  it('notifies loading/loaded once, when the command is found', async () => {
    const seen: string[] = []
    const kernel = new Kernel()
    kernel.addLoader({
      getMetaData: async () => [Provision.serialize()],
      getCommand: async () => Provision,
    })
    kernel.loading((metadata) => {
      seen.push(`loading:${metadata.commandName}`)
    })
    kernel.loaded((command) => {
      seen.push(`loaded:${command.commandName}`)
    })

    // Booting only reads what the loaders offer; nothing is "loaded" until a
    // command is asked for.
    await kernel.boot()
    expect(seen).toEqual([])

    await kernel.find('provision')
    expect(seen).toEqual(['loading:provision', 'loaded:provision'])
  })

  it('builds a subclass from its own factory', () => {
    class Welcome extends BaseCommand {
      static override commandName = 'welcome'
      static override description = 'The landing command'
      run(): void {}
    }
    class Custom extends Kernel {
      static override defaultCommand = Welcome
    }

    // `create()` must honour the statics of the class it was called on, not
    // Kernel's — otherwise the factory and `new` disagree.
    expect(Custom.create().getDefaultCommand().commandName).toBe('welcome')
  })

  it('finds a command through its alias, and throws on an unknown name', async () => {
    const kernel = new Kernel().register(Provision).addAlias('setup', 'provision')

    // Async and throwing, as in Console — `await` on a synchronous answer is fine.
    expect((await kernel.find('setup')).commandName).toBe('provision')
    await expect(kernel.find('nope')).rejects.toThrow(/Unknown command "nope"/)
  })

  it('hands the command a caller-supplied UI', async () => {
    class Report extends BaseCommand {
      static override commandName = 'report'
      static override description = 'Logs'
      run(): void {
        this.logger.log('hello')
      }
    }

    const kernel = new Kernel().register(Report)
    const ui = new Ui()
    ui.switchMode('raw')

    const command = await kernel.exec('report', [], { ui })
    // Captured by the caller's UI, leaving the kernel's own untouched.
    expect(ui.getLogs()).toEqual(['hello'])
    expect(kernel.ui.getLogs()).toEqual([])
    command.assertLog('hello')
  })

  it('exposes the default command and the one the command line ran', async () => {
    const kernel = new Kernel().register(Provision)
    expect(kernel.getDefaultCommand().commandName).toBe('list')
    expect(kernel.getMainCommand()).toBeUndefined()

    await kernel.handle(['provision', '--email', 'ada@example.ch'])
    // Compared on the class: `CommandInstance` is the structural contract, and
    // `commandName` is a BaseCommand getter that a structural command lacks.
    expect(kernel.getMainCommand()?.constructor).toBe(Provision)
  })

  it('registers the aliases a loader announced in its metadata', async () => {
    const kernel = new Kernel()
    kernel.addLoader({
      // A manifest-style loader publishes aliases the class need not repeat.
      getMetaData: async () => [{ ...Provision.serialize(), aliases: ['setup'] }],
      getCommand: async () => Provision,
    })

    await kernel.boot()
    expect(kernel.hasCommand('setup')).toBe(true)
    expect(kernel.getAliases()).toEqual(['setup'])
    expect((await kernel.find('setup')).commandName).toBe('provision')
  })

  it('builds a command without running it', async () => {
    const before = ran.length
    const command = await new Kernel().create(Provision, ['--email', 'ada@example.ch'])

    // Parsed, injected and hydrated — everything exec() does but the lifecycle.
    expect(command.email).toBe('ada@example.ch')
    expect(command.name).toBe('Owner')
    expect(ran).toHaveLength(before)
  })

  it('runs a subclass default command', async () => {
    class Welcome extends BaseCommand {
      static override commandName = 'welcome'
      static override description = 'The landing command'
      run(): string {
        return 'welcomed'
      }
    }
    class Custom extends Kernel {
      static override defaultCommand = Welcome
    }

    const kernel = new Custom()
    expect(kernel.getDefaultCommand().commandName).toBe('welcome')

    await kernel.handle([])
    expect(kernel.getMainCommand()?.constructor).toBe(Welcome)
  })

  it('reports the failure of the command line through its error handler', async () => {
    class Fails extends BaseCommand {
      static override commandName = 'fails'
      static override description = 'Throws'
      run(): never {
        throw new Error('boom')
      }
    }

    const { kernel, failure } = kernelCapturing(Fails)
    // `handle()` owns the process, so it REPORTS rather than throws — and the
    // renderer is the seam an application replaces to report its own way.
    await expect(kernel.handle(['fails'])).resolves.toEqual({ staysAlive: false })
    expect(String(failure())).toContain('boom')
    expect(kernel.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('builds and runs commands through the executor it was given', async () => {
    const seen: string[] = []
    class Custom extends Kernel {
      static override commandExecutor = {
        create: (
          Command: CommandClass,
          parsed: ParsedInput,
          kernel: Kernel,
          context: { isMain: boolean; ui: Ui },
        ) => {
          seen.push(`create:${Command.commandName}`)
          return kernel.buildCommand(Command, parsed, context)
        },
        run: (command: CommandInstance, kernel: Kernel) => {
          seen.push('run')
          return kernel.runLifecycle(command)
        },
      }
    }

    // The seam AdonisJS itself uses to add DI — Ream's default already does it,
    // and replacing it must not cost the container.
    const application = new Application()
    application.container.singleton('marker', () => 'injected')

    class Needs extends BaseCommand {
      static override commandName = 'needs'
      static override description = 'Needs the container'
      static override options = { startApp: true }
      async run(): Promise<string> {
        return String(await this.app.container.resolve('marker'))
      }
    }

    const kernel = new Custom({ startApp: async () => application }).register(Needs)
    const command = await kernel.exec('needs')

    expect(seen).toEqual(['create:needs', 'run'])
    expect(command.result).toBe('injected')
  })

  it('refuses a global flag or a loader once it has left idle', async () => {
    const kernel = new Kernel()
    await kernel.boot()

    // Both would silently do nothing: the commands are loaded and the parser
    // options are already built.
    expect(kernel.getState()).toBe('booted')
    expect(() => kernel.defineFlag('late')).toThrow(/while the kernel was "booted"/)
    expect(() =>
      kernel.addLoader({ getMetaData: async () => [], getCommand: async () => null }),
    ).toThrow(/while the kernel was "booted"/)
  })

  it('refuses to run anything more once the command line is done', async () => {
    const kernel = new Kernel()
    await kernel.handle(['list'])

    expect(kernel.getState()).toBe('completed')
    await expect(kernel.exec('list')).rejects.toThrow(/kernel has finished/)
  })

  it('does not offer the global flags to exec()', async () => {
    class Plain extends BaseCommand {
      static override commandName = 'plain'
      static override description = 'Declares no flags'
      run(): void {}
    }

    // Global flags belong to the command line. Through exec() the caller is
    // passing a flag the command does not accept, and Console says so.
    await expect(new Kernel().register(Plain).exec('plain', ['--no-ansi'])).rejects.toThrow(
      /Unknown flag "--no-ansi"/,
    )
  })

  it('lets a command redeclare a global flag', async () => {
    let value: unknown
    class Paint extends BaseCommand {
      static override commandName = 'paint'
      static override description = 'Has its own idea of --ansi'

      @flags.string({ flagName: 'ansi' })
      declare ansi: string

      run(): void {
        value = this.ansi
      }
    }

    delete process.env.FORCE_COLOR
    delete process.env.NO_COLOR

    await new Kernel().register(Paint).handle(['paint', '--ansi', 'always'])
    expect(value).toBe('always')
    // The command owns the name, so the global listener must not act on its
    // value — "always" is not the global boolean the listener expects.
    expect(process.env.NO_COLOR).toBeUndefined()
    expect(process.env.FORCE_COLOR).toBeUndefined()
  })

  it('leaves an optional spread undefined when nothing was given', async () => {
    let seen: unknown = 'untouched'
    class Deploy extends BaseCommand {
      static override commandName = 'deploy'
      static override description = 'Deploys'

      @args.spread({ required: false })
      declare targets: string[]

      run(): void {
        seen = this.targets
      }
    }

    // Console leaves it undefined: a command distinguishing "no target given" from
    // "an empty list of targets" cannot do it against a silent [].
    await new Kernel().register(Deploy).handle(['deploy'])
    expect(seen).toBeUndefined()

    await new Kernel().register(Deploy).handle(['deploy', 'prod', 'staging'])
    expect(seen).toEqual(['prod', 'staging'])
  })

  it('lets a staysAlive command end itself through terminate()', async () => {
    const onTerminate = vi.fn()
    class Worker extends BaseCommand {
      static override commandName = 'worker'
      static override description = 'Long running'
      static override options = { staysAlive: true }
      async run(): Promise<void> {
        await this.terminate()
      }
    }

    const result = await new Kernel({ onTerminate }).register(Worker).handle(['worker'])
    expect(onTerminate).toHaveBeenCalledTimes(1)
    expect(result.staysAlive).toBe(true)
  })
})

describe('Kernel — remaining Console contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers to a static alias declared on the command', async () => {
    let ran = false
    class Welcome extends BaseCommand {
      static override commandName = 'app:welcome'
      static override description = 'Greets'
      static override aliases = ['welcome', 'hi']
      run(): void {
        ran = true
      }
    }

    // A fresh kernel per dispatch: one kernel owns one command line.
    await new Kernel().register(Welcome).handle(['welcome'])
    expect(ran).toBe(true)

    ran = false
    await new Kernel().register(Welcome).handle(['hi'])
    expect(ran).toBe(true)
  })

  it('substitutes {{ binaryName }} in the help block', async () => {
    class Documented extends BaseCommand {
      static override commandName = 'documented'
      static override description = 'Has a help block'
      static override help = ['Run it as: {{ binaryName }} documented --force']
      run(): void {}
    }

    const captured = captureOutput()
    await new Kernel({ binaryName: 'ream' }).register(Documented).handle(['documented', '--help'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('Run it as: ream documented --force')
    expect(output).not.toContain('{{ binaryName }}')
  })

  it('keeps a quoted value together in an alias expansion', async () => {
    let seen: string | undefined
    class MakePost extends BaseCommand {
      static override commandName = 'make:post'
      static override description = 'Creates a post'

      @flags.string()
      declare title: string

      run(): void {
        seen = this.title
      }
    }

    const kernel = new Kernel()
      .register(MakePost)
      .addAlias('draft', 'make:post --title "Blog Post"')

    await kernel.handle(['draft'])
    // A plain split on whitespace would have produced --title "Blog + Post".
    expect(seen).toBe('Blog Post')
  })

  it('keeps the value of an undeclared flag when they are allowed', async () => {
    let flags: Record<string, unknown> | undefined
    class Proxy extends BaseCommand {
      static override commandName = 'proxy'
      static override description = 'Forwards whatever it is given'
      static override options = { allowUnknownFlags: true }
      run(): void {
        flags = this.parsed.flags
      }
    }

    await new Kernel().register(Proxy).handle(['proxy', '--foo', 'bar', '--verbose'])
    // `--foo bar` must not degrade to `foo: true` with `bar` dropped.
    expect(flags).toEqual({ foo: 'bar', verbose: true })
  })
})

describe('Kernel — proxy mode and alias visibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps extra positionals for a proxy command instead of dropping them', async () => {
    let parsed: { flags: unknown; extraArgs: string[]; unknownFlags: string[] } | undefined
    class Proxy extends BaseCommand {
      static override commandName = 'proxy'
      static override description = 'Forwards whatever it is given'
      static override options = { allowUnknownFlags: true }
      run(): void {
        parsed = {
          flags: this.parsed.flags,
          extraArgs: this.parsed.extraArgs,
          unknownFlags: this.parsed.unknownFlags,
        }
      }
    }

    await new Kernel().register(Proxy).handle(['proxy', 'run', 'build', '--foo', 'bar'])
    expect(parsed?.flags).toEqual({ foo: 'bar' })
    // Console exposes the NAMES of undeclared flags; their values stay in `flags`.
    expect(parsed?.unknownFlags).toEqual(['foo'])
    // Without this they were accepted and then silently lost.
    expect(parsed?.extraArgs).toEqual(['run', 'build'])
  })

  it('still reports extra positionals for a normal command', async () => {
    class Greet extends BaseCommand {
      static override commandName = 'greet'
      static override description = 'Greets'

      @args.string()
      declare name: string

      run(): void {}
    }
    const { kernel, failure } = kernelCapturing(Greet)
    await kernel.handle(['greet', 'john', 'extra'])
    expect(String(failure())).toMatch(/Unexpected argument "extra"/)
  })

  it('shows aliases in list and suggests them on a typo', async () => {
    class Welcome extends BaseCommand {
      static override commandName = 'app:welcome'
      static override description = 'Greets'
      static override aliases = ['welcome']
      run(): void {}
    }

    const listed = captureOutput()
    await new Kernel().register(Welcome).handle(['list'])
    const listing = listed.out()
    listed.restore()
    expect(listing).toContain('welcome')

    const json = captureOutput()
    await new Kernel().register(Welcome).handle(['list', '--json'])
    const payload = JSON.parse(json.out())
    json.restore()
    expect(payload[0].aliases).toEqual(['welcome'])

    const typo = captureOutput()
    await new Kernel().register(Welcome).handle(['welcom'])
    const reported = typo.out()
    typo.restore()
    expect(reported).toContain('Did you mean "welcome"?')
    process.exitCode = 0
  })
})

describe('Kernel — negated flag variant in help', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists --no-<flag> only when the flag asks for it', async () => {
    class Build extends BaseCommand {
      static override commandName = 'build'
      static override description = 'Builds'

      @flags.boolean({ showNegatedVariantInHelp: true })
      declare cache: boolean

      @flags.boolean()
      declare verbose: boolean

      run(): void {}
    }

    const captured = captureOutput()
    await new Kernel().register(Build).handle(['build', '--help'])
    const output = captured.out()
    captured.restore()

    // Booleans are always negatable; this option only decides what help says.
    expect(output).toContain('--cache | --no-cache')
    expect(output).not.toContain('--no-verbose')
  })
})

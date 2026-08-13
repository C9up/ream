/**
 * Console kernel — registers commands and dispatches argv against them.
 *
 * Replaces the previous `CommandRunner`, which parsed argv without knowing the
 * commands' declared inputs and therefore could not support `--flag value`,
 * aliases, negation, typed flags, per-command help or required-input checks.
 *
 * The kernel accepts any class exposing the static contract in `types.ts` —
 * extending `BaseCommand` is optional, which is what keeps agnostic packages
 * free of a `@c9up/ream` dependency.
 */

import type { Application } from '../Application.js'
import { isReamError, ReamError } from '../errors/ReamError.js'
import { createAssertions, createSnapshot } from './assertions.js'
import { type Logger, Ui } from './cliui.js'
import { buildFlag } from './decorators.js'
import { ExceptionHandler } from './ExceptionHandler.js'
import HelpCommand from './HelpCommand.js'
import ListCommand from './ListCommand.js'
import { assignParsedValues, parseArgv, validateParsed } from './parser.js'
import { Prompt } from './prompts.js'
import { commandExec } from './tracing.js'
import {
  type CommandClass,
  type CommandInstance,
  type ExecutedCommand,
  type FlagMetaData,
  isCommandClass,
  type ParsedInput,
  type SerializedCommand,
} from './types.js'
import { renderErrorWithSuggestions } from './utils.js'

/**
 * Called when a global flag was passed to the command invoked from the command
 * line. Returning `true` stops the dispatch before the command runs.
 */
/** The kernel's lifecycle stage — Ace `getState()`. */
export type KernelState = 'idle' | 'booted' | 'running' | 'completed'

/**
 * A source of commands (Ace `LoadersContract`).
 *
 * Two steps, as in Ace: the metadata of everything it offers, then the class
 * for one of them — a loader that reads a directory can answer the first from
 * a manifest without importing anything.
 */
export interface CommandLoader {
  getMetaData(): Promise<SerializedCommand[]>
  getCommand(metadata: SerializedCommand): Promise<CommandClass | null>
}

/**
 * How a command is built and run (Ace `ExecutorContract`).
 *
 * `create` returns the instance, ready but untouched; `run` drives its
 * lifecycle and returns what `run()` produced.
 */
export interface CommandExecutor {
  /**
   * The fourth argument is Ream's: which UI the command writes through, and
   * whether it is the one the command line invoked. An executor ported from
   * Ace simply ignores it.
   */
  create(
    Command: CommandClass,
    parsed: ParsedInput,
    kernel: Kernel,
    context: { isMain: boolean; ui: Ui },
  ): CommandInstance | Promise<CommandInstance>
  /** Runs `prepare`, `interact` and `run`, and throws what they throw. */
  run(command: CommandInstance, kernel: Kernel): unknown
}

/** Renders the failure of the command line (Ace `ExceptionHandler`). */
export interface ErrorRenderer {
  render(error: unknown, kernel: Kernel): void | Promise<void>
}

export type GlobalFlagListener = (
  command: CommandClass,
  kernel: Kernel,
  parsed: ParsedInput,
  // biome-ignore lint/suspicious/noConfusingVoidType: Ace contract — returning `true` ends the dispatch, returning nothing is the normal case
) => boolean | void | Promise<boolean | void>

import { colourise } from './ui.js'

export interface KernelOptions {
  /**
   * Boots the application. Called only for commands declaring
   * `options.startApp` — a scaffolding command must not open a DB connection.
   */
  startApp?: () => Promise<Application>
  /** Shown in usage lines. */
  binaryName?: string
  /**
   * Shuts the application down. Handed to the command as `this.terminate()`,
   * the only way a `staysAlive` command can end itself.
   */
  onTerminate?: () => void | Promise<void>
  /**
   * The prompt handed to every command as `this.prompt`.
   *
   * Supply one to script its answers with `trap()`: without this the kernel
   * builds its own, and a command that asks anything is untestable through
   * `exec()` — it would reach a terminal that is not there.
   */
  prompt?: Prompt
}

export interface HandleResult {
  /** The command asked to keep the process alive (worker, watcher…). */
  staysAlive: boolean
}

export class Kernel {
  readonly #commands = new Map<string, CommandClass>()
  /**
   * Commands a loader announced but whose class has not been imported yet.
   *
   * Booting reads metadata only, as Ace does: listing the commands, answering
   * `hasCommand()` or printing help must not run the module of a command
   * nobody asked for.
   */
  readonly #pending = new Map<string, { metadata: SerializedCommand; loader: CommandLoader }>()
  readonly #aliases = new Map<string, string[]>()
  /**
   * Commands the kernel registered on its own behalf, which an application may
   * replace — see {@link register}.
   */
  readonly #defaults = new Set<string>()
  /** Flags every command accepts — Ace's global command. */
  readonly #globalFlags: FlagMetaData[] = []
  readonly #flagListeners = new Map<string, GlobalFlagListener>()
  readonly #loaders: Array<CommandLoader | (() => Promise<CommandLoader>)> = []
  readonly #hooks: {
    finding: Array<(commandName: string) => void | Promise<void>>
    loading: Array<(metadata: SerializedCommand) => void | Promise<void>>
    loaded: Array<(command: CommandClass) => void | Promise<void>>
    executing: Array<(command: CommandInstance, isMain: boolean) => void | Promise<void>>
    executed: Array<(command: CommandInstance, isMain: boolean) => void | Promise<void>>
  } = { finding: [], loading: [], loaded: [], executing: [], executed: [] }
  #state: KernelState = 'idle'
  #mainCommand: CommandInstance | undefined
  readonly #defaultCommand: CommandClass
  readonly #executor: CommandExecutor
  /** The application a command was built with, when it asked for one. */
  readonly #apps = new WeakMap<CommandInstance, Application>()
  readonly #startApp: (() => Promise<Application>) | undefined
  readonly #onTerminate: (() => void | Promise<void>) | undefined
  readonly #prompt: Prompt | undefined
  readonly #binaryName: string
  /** Shared by the kernel and every command it runs. */
  readonly ui = new Ui()
  readonly logger: Logger = this.ui.logger

  /**
   * The command a kernel runs when none is named. Replace it to ship a
   * different landing command (Ace `Kernel.defaultCommand`).
   */
  static defaultCommand: CommandClass = ListCommand

  /**
   * How a command is built and run (Ace `Kernel.commandExecutor`).
   *
   * The seam AdonisJS itself uses to add dependency injection; Ream's default
   * already does it — the container builds the command and invokes its hooks,
   * so `@inject()` works on both. Replace it on a subclass to drive commands
   * some other way.
   */
  static commandExecutor: CommandExecutor = {
    create(Command, parsed, kernel, context) {
      return kernel.buildCommand(Command, parsed, context)
    },
    run(command, kernel) {
      return kernel.runLifecycle(command)
    },
  }

  /**
   * What the CLI says about itself — binary name, versions. Printed above the
   * command listing when it holds anything (Ace `kernel.info`).
   */
  readonly info = new Map<string, string | number | boolean>()

  /**
   * Renders the failure of the command line (Ace `kernel.errorHandler`).
   *
   * Replaceable: an application that wants its own reporting sets it here
   * rather than wrapping `handle()`, which is what owns the process.
   */
  errorHandler: ErrorRenderer = new ExceptionHandler()

  /**
   * The exit code the command line ended on (Ace `kernel.exitCode`). Set once
   * the dispatch is over: 1 for a failure, otherwise the command's own.
   */
  exitCode: number | undefined

  /**
   * Ace's factory — `Kernel.create()` reads better than `new Kernel()`.
   *
   * Built through `this`, so a subclass overriding `defaultCommand` or
   * `commandExecutor` gets its own from the factory as well as from `new`.
   */
  static create<T extends typeof Kernel>(this: T, options: KernelOptions = {}): InstanceType<T> {
    return new this(options) as InstanceType<T>
  }

  constructor(options: KernelOptions = {}) {
    this.#startApp = options.startApp
    this.#onTerminate = options.onTerminate
    this.#prompt = options.prompt
    this.#binaryName = options.binaryName ?? 'ream'
    // `list` is a command, not a branch in the dispatcher — Ace registers it the
    // same way, which is what makes `hasCommand('list')`, `exec('list')` and
    // `help list` true statements instead of special cases.
    // Read off `new.target`, so a subclass overriding `static defaultCommand`
    // gets its own (Ace's customisation point).
    this.#defaultCommand = new.target.defaultCommand
    this.#executor = new.target.commandExecutor
    this.register(this.#defaultCommand)
    this.#defaults.add(this.#defaultCommand.commandName)
    // `help` is a command for the same reason `list` is: everything the
    // registry guarantees — introspection, `exec()`, replaceability — is false
    // for a name only the dispatcher knows.
    this.register(HelpCommand)
    this.#defaults.add(HelpCommand.commandName)

    // Ace's `--help`, a global flag whose listener runs the help command.
    this.defineFlag('help', {
      type: 'boolean',
      alias: ['h'],
      description: 'Display help for the given command',
    })
    this.on('help', async (Command, kernel, parsed) => {
      // Only the mention, not `--no-help`.
      if (parsed.flags.help !== true) return false
      // Whatever was resolved: the named command, or the default one for a bare
      // `ream --help` — whose own help documents the listing.
      await kernel.exec('help', [Command.commandName])
      return true
    })

    // Ace's `--ansi` / `--no-ansi`, declared as what they are: a global flag.
    // Declaring them makes them visible in help and rejected nowhere, instead
    // of being intercepted by a special case in the dispatcher.
    this.defineFlag('ansi', {
      type: 'boolean',
      description: 'Force colours on, or off with --no-ansi',
      showNegatedVariantInHelp: true,
    })
    this.on('ansi', (_command, _kernel, parsed) => {
      if (parsed.flags.ansi === true) {
        process.env.FORCE_COLOR = '1'
        delete process.env.NO_COLOR
        return
      }
      process.env.NO_COLOR = '1'
      delete process.env.FORCE_COLOR
    })
  }

  /** Shown in usage lines — commands read it to print their own. */
  get binaryName(): string {
    return this.#binaryName
  }

  /**
   * Declare a flag every command accepts (Ace `kernel.defineFlag`).
   *
   * Global flags steer the CLI, not the command: they are merged into the
   * parser so no command has to redeclare them, and they are NOT assigned to
   * the command's properties — a command reads them through `this.parsed.flags`
   * or, more usually, does not read them at all.
   */
  defineFlag(name: string, options: Partial<FlagMetaData> = {}): this {
    if (this.#state !== 'idle') {
      throw new ReamError(
        'E_CONSOLE_LATE_GLOBAL_FLAG',
        `Global flag "--${name}" was declared while the kernel was "${this.#state}".`,
        { hint: 'Declare global flags while wiring the kernel, before booting it.' },
      )
    }
    this.#globalFlags.push(buildFlag(name, options))
    return this
  }

  /** The global flags — Ace `kernel.flags`. */
  get flags(): readonly FlagMetaData[] {
    return [...this.#globalFlags]
  }

  /**
   * React to a global flag (Ace `kernel.on`). One listener per flag, the last
   * one registered winning, and only for the command invoked from the command
   * line. Returning `true` stops there, without running the command — that is
   * how `--help` short-circuits.
   */
  on(flagName: string, listener: GlobalFlagListener): this {
    this.#flagListeners.set(flagName, listener)
    return this
  }

  register(command: CommandClass): this {
    const existing = this.#commands.get(command.commandName)
    if (existing !== undefined && existing !== command) {
      // The kernel's own defaults are replaceable: one registry, and the
      // application wins — an app shipping its own `list` gets it, the same
      // rule the CLI applies to the built-in commands it shadows. Two
      // APPLICATION commands claiming one name stays an error: there is
      // nothing to arbitrate between them.
      if (!this.#defaults.has(command.commandName)) {
        throw new ReamError(
          'E_CONSOLE_DUPLICATE_COMMAND',
          `Two commands claim the name "${command.commandName}".`,
          { hint: 'Rename one of them, or namespace it (e.g. "app:provision").' },
        )
      }
      this.#defaults.delete(command.commandName)
    }
    this.#pending.delete(command.commandName)
    this.#commands.set(command.commandName, command)
    // `static aliases` travel with the command; rc-level `commandsAliases` are
    // registered separately and may still override these.
    for (const alias of command.aliases ?? []) {
      this.#aliases.set(alias, [command.commandName])
    }
    return this
  }

  registerMany(commands: Iterable<CommandClass>): this {
    for (const command of commands) this.register(command)
    return this
  }

  /**
   * Register the default export of a loaded module when it is a command.
   * Returns whether anything was registered, so the caller can report a module
   * that exports the wrong shape instead of ignoring it.
   */
  registerModule(mod: unknown): boolean {
    if (typeof mod !== 'object' || mod === null) return false
    const value = Reflect.get(mod, 'default')
    if (!isCommandClass(value)) return false
    this.register(value)
    return true
  }

  /**
   * Register a shorthand expanding to a command and, optionally, its flags —
   * Ace's `commandsAliases`. `resource` → `make:controller --resource` means
   * `ream resource users` runs `ream make:controller --resource users`.
   */
  addAlias(alias: string, expansion: string): this {
    const tokens = tokeniseExpansion(expansion)
    if (tokens.length === 0) {
      throw new ReamError('E_CONSOLE_INVALID_ALIAS', `Alias "${alias}" expands to nothing.`, {
        hint: 'Expected a command name, e.g. "make:controller --resource".',
      })
    }
    this.#aliases.set(alias, tokens)
    return this
  }

  /**
   * Resolve a command by name or alias — Ace's `find()`.
   *
   * Async and throwing, as in Ace: a name that resolves to nothing is a call
   * error, and returning `undefined` pushes every caller into a check it
   * usually forgets. `await` works even though Ream's registry answers
   * immediately.
   */
  async find(name: string): Promise<CommandClass> {
    const [resolved] = this.#expandAlias([name])
    const commandName = resolved ?? name
    await this.#emit(this.#hooks.finding, (handler) => handler(commandName))

    const loaded = this.#commands.get(commandName)
    if (loaded !== undefined) {
      await this.#emit(this.#hooks.loading, (handler) => handler(this.#metadataFor(loaded)))
      await this.#emit(this.#hooks.loaded, (handler) => handler(loaded))
      return loaded
    }

    const pending = this.#pending.get(commandName)
    if (pending === undefined) {
      throw new ReamError('E_CONSOLE_COMMAND_NOT_FOUND', `Unknown command "${name}".`, {
        hint: 'Check the name with hasCommand() first, or list them with getCommands().',
      })
    }

    await this.#emit(this.#hooks.loading, (handler) => handler(pending.metadata))

    // Here is where a loader's module is imported — for the command that was
    // actually asked for, and once.
    const command = await pending.loader.getCommand(pending.metadata)
    if (command === null) {
      throw new ReamError(
        'E_CONSOLE_COMMAND_NOT_FOUND',
        `The loader announced "${commandName}" but did not provide it.`,
        { hint: 'A loader must return the command it listed in its metadata.' },
      )
    }

    this.register(command)
    await this.#emit(this.#hooks.loaded, (handler) => handler(command))
    return command
  }

  /**
   * Register a source of commands (Ace `kernel.addLoader`).
   *
   * Consumed by {@link boot}, once. Unlike Ace, the classes are resolved there
   * and then rather than on first use: Ream's registry holds classes, which is
   * what lets `find()` and `hasCommand()` answer without waiting on a loader.
   */
  addLoader(loader: CommandLoader | (() => Promise<CommandLoader>)): this {
    if (this.#state !== 'idle') {
      throw new ReamError(
        'E_CONSOLE_LATE_LOADER',
        `A command loader was added while the kernel was "${this.#state}".`,
        { hint: 'Add loaders before booting the kernel.' },
      )
    }
    this.#loaders.push(loader)
    return this
  }

  /**
   * Load every registered loader's commands. Idempotent, and called by
   * `handle()` — an application driving its own dispatch calls it itself.
   */
  async boot(): Promise<void> {
    if (this.#state !== 'idle') return
    this.#state = 'booted'

    for (const entry of this.#loaders) {
      const loader = typeof entry === 'function' ? await entry() : entry
      for (const metadata of await loader.getMetaData()) {
        // Metadata only — the class is imported by `find()`, when someone asks
        // for the command. `loading` / `loaded` belong there too.
        if (!this.#commands.has(metadata.commandName)) {
          this.#pending.set(metadata.commandName, { metadata, loader })
        }
        // The metadata is what a manifest-style loader publishes; its aliases
        // may be richer than the class's `static aliases`, and reading only the
        // class would leave `hasCommand(alias)` answering false for a name the
        // loader announced.
        for (const alias of metadata.aliases) this.addAlias(alias, metadata.commandName)
      }
    }
  }

  /** The kernel's lifecycle stage — Ace `getState()`. */
  getState(): KernelState {
    return this.#state
  }

  /**
   * The command run when none is named — the one this kernel was built with,
   * or the application's replacement when it registered one under that name.
   */
  getDefaultCommand(): CommandClass {
    return this.#commands.get(this.#defaultCommand.commandName) ?? this.#defaultCommand
  }

  /** The command invoked from the command line, once it has been built. */
  getMainCommand(): CommandInstance | undefined {
    return this.#mainCommand
  }

  /** Before a command name is resolved (Ace hook). */
  finding(callback: (commandName: string) => void | Promise<void>): this {
    this.#hooks.finding.push(callback)
    return this
  }

  /** Before a command class is read from its loader (Ace hook). */
  loading(callback: (metadata: SerializedCommand) => void | Promise<void>): this {
    this.#hooks.loading.push(callback)
    return this
  }

  /** After a command class has been loaded (Ace hook). */
  loaded(callback: (command: CommandClass) => void | Promise<void>): this {
    this.#hooks.loaded.push(callback)
    return this
  }

  /** Before a command runs. `isMain` distinguishes the CLI dispatch. */
  executing(callback: (command: CommandInstance, isMain: boolean) => void | Promise<void>): this {
    this.#hooks.executing.push(callback)
    return this
  }

  /** After a command has run — not when it failed, as in Ace. */
  executed(callback: (command: CommandInstance, isMain: boolean) => void | Promise<void>): this {
    this.#hooks.executed.push(callback)
    return this
  }

  /**
   * The metadata of every registered command, as Ace exposes it.
   *
   * Metadata rather than the classes themselves: this is the introspection
   * surface (help, completions, a command palette), and handing out the
   * constructors invites callers to instantiate a command outside the kernel,
   * where nothing injects its dependencies or runs its lifecycle. The class is
   * still reachable through {@link find} when a caller genuinely needs it.
   */
  getCommands(): SerializedCommand[] {
    return this.#allMetadata()
  }

  /** One command's metadata, or null — Ace's `getCommand()`. */
  getCommand(commandName: string): SerializedCommand | null {
    const command = this.#commands.get(commandName)
    if (command !== undefined) return this.#metadataFor(command)
    const pending = this.#pending.get(commandName)
    // Answered from the metadata a loader published: describing a command must
    // not require importing it.
    return pending === undefined
      ? null
      : { ...pending.metadata, aliases: this.#aliasesFor(commandName) }
  }

  /**
   * The commands of one namespace. Called without one — or with an empty
   * string — it answers with the commands that have no namespace at all, which
   * is the group Ace's own listing prints first.
   */
  getNamespaceCommands(namespace?: string): SerializedCommand[] {
    const wanted = namespace === undefined || namespace === '' ? null : namespace
    return this.#allMetadata().filter((command) => command.namespace === wanted)
  }

  /** Every namespace in use, sorted. */
  getNamespaces(): string[] {
    const found = new Set<string>()
    for (const commandName of this.#names()) {
      const namespace = namespaceOf(commandName)
      if (namespace !== null) found.add(namespace)
    }
    return [...found].sort((a, b) => a.localeCompare(b))
  }

  /** Every registered alias — `static aliases` and the rc file's alike. */
  getAliases(): string[] {
    return [...this.#aliases.keys()].sort((a, b) => a.localeCompare(b))
  }

  /** The command an alias stands for, or null when the alias is unknown. */
  getAliasCommand(alias: string): SerializedCommand | null {
    const expansion = this.#aliases.get(alias)
    if (expansion === undefined) return null
    return this.getCommand(expansion[0] ?? '')
  }

  /** Every alias pointing at this command. */
  getCommandAliases(commandName: string): string[] {
    return this.#aliasesFor(commandName)
  }

  /**
   * Names close enough to this one to be what the user meant — Ace's
   * suggestions. Aliases are included: they are names one can legitimately
   * type, so a typo on one deserves the same help.
   */
  getCommandSuggestions(name: string): string[] {
    return suggestFrom(name, [...this.#names(), ...this.#aliases.keys()])
  }

  getNamespaceSuggestions(name: string): string[] {
    return suggestFrom(name, this.getNamespaces())
  }

  async handle(
    rawArgv: readonly string[],
    nodeArgs: readonly string[] = [],
  ): Promise<HandleResult> {
    if (this.#state === 'running') {
      throw new ReamError(
        'E_CONSOLE_KERNEL_RUNNING',
        'A command is already running through this kernel.',
        { hint: 'One kernel drives one command line. Use exec() to call another command.' },
      )
    }
    if (this.#state === 'completed') {
      throw new ReamError(
        'E_CONSOLE_KERNEL_COMPLETED',
        'The kernel has finished; it cannot run another command line.',
        { hint: 'Create a fresh kernel.' },
      )
    }

    await this.boot()
    this.#state = 'running'
    try {
      return await this.#dispatch(rawArgv, nodeArgs)
    } catch (error) {
      // The command line owns the process, so a failure is REPORTED here rather
      // than thrown at a caller who has nothing better to do with it — Ace's
      // rule. `exec()` is the path that rethrows.
      this.exitCode = 1
      process.exitCode = 1
      await this.errorHandler.render(error, this)
      return { staysAlive: false }
    } finally {
      // In `finally`, not after the call: `handle()` returns early on help, on
      // an unknown command and on a short-circuiting flag listener. A state set
      // on the success path alone lies on every other one.
      this.#state = 'completed'
    }
  }

  async #dispatch(rawArgv: readonly string[], nodeArgs: readonly string[]): Promise<HandleResult> {
    const argv = this.#expandAlias(this.#hoistGlobalFlags(rawArgv))
    const [name, ...rest] = argv

    // Resolved through `find()`, like Ace's own CLI path: it is what runs the
    // finding/loading/loaded hooks, and a tool listening to them must see the
    // command line, not only `exec()`.
    //
    // The default command goes through `find()` too: `ream` bare and
    // `ream <command>` must run the same cycle, hooks included. Resolved by
    // NAME, so an application that replaced it gets its own.
    const target = name ?? this.getDefaultCommand().commandName
    let Command: CommandClass
    try {
      Command = await this.find(target)
    } catch (error) {
      // An unknown name gets the listing's help, not a stack trace: a typo is
      // the most common way to reach this.
      if (isReamError(error, 'E_CONSOLE_COMMAND_NOT_FOUND')) {
        this.#reportUnknown(target)
        return { staysAlive: false }
      }
      throw error
    }

    const argvForCommand = name === undefined ? [] : rest

    const parsed = this.#parse(Command, argvForCommand, nodeArgs, true)
    if (await this.#runFlagListeners(Command, parsed)) return { staysAlive: false }
    this.#validate(Command, parsed)

    const instance = await this.#runCommand(Command, parsed, true)
    this.#mainCommand = instance

    const failure = Reflect.get(instance, 'error')
    if (failure !== undefined) throw failure

    const exitCode = Reflect.get(instance, 'exitCode')
    if (typeof exitCode === 'number') this.exitCode = exitCode
    if (typeof exitCode === 'number' && exitCode !== 0) process.exitCode = exitCode

    return { staysAlive: Command.options?.staysAlive === true }
  }

  /**
   * Parse, build and run one command through its full lifecycle.
   *
   * Shared by `handle()` (the CLI path, which rethrows) and `exec()` (the
   * programmatic path, which reports through the returned instance). Errors are
   * recorded on the instance rather than thrown, so both callers decide what to
   * do with them instead of the logic being written twice.
   */
  /**
   * Read argv against a command's declarations, global flags included.
   *
   * Separate from {@link #runCommand} because the main command's parsed input
   * is needed BEFORE the command is built: Ace's global-flag listeners see it,
   * and one of them may end the dispatch.
   */
  #parse(
    Command: CommandClass,
    argv: readonly string[],
    nodeArgs: readonly string[],
    withGlobalFlags: boolean,
  ): ParsedInput {
    const parsed = parseArgv(argv, {
      args: Command.args,
      // Global flags belong to the command line: they are merged for the
      // command invoked there, and NOT for `exec()`, as in Ace. A caller
      // passing `--no-ansi` to exec() is passing a flag the command does not
      // accept, and hearing so is the point.
      flags: withGlobalFlags ? this.#flagsFor(Command) : (Command.flags ?? []),
      allowUnknownFlags: Command.options?.allowUnknownFlags,
      commandName: Command.commandName,
      // Leniently: the required inputs are checked AFTER the global-flag
      // listeners have had their say, which is what makes `--help` work on a
      // command whose flags are required (Ace's order).
      validate: false,
    })
    parsed.nodeArgs = [...nodeArgs]
    return parsed
  }

  /** Hold the parsed input to the command's declarations — after the listeners. */
  #validate(Command: CommandClass, parsed: ParsedInput): void {
    validateParsed(parsed, {
      args: Command.args,
      flags: Command.flags,
      allowUnknownFlags: Command.options?.allowUnknownFlags,
      commandName: Command.commandName,
    })
  }

  /**
   * Run the listeners of the global flags that were passed. Returns whether one
   * of them ended the dispatch.
   *
   * Ace runs them for the main command only, and before it is built: a command
   * that will not run must not boot the application first.
   */
  async #runFlagListeners(Command: CommandClass, parsed: ParsedInput): Promise<boolean> {
    for (const [flagName, listener] of this.#flagListeners) {
      if (parsed.flags[flagName] === undefined) continue
      // A command redeclaring the name owns the flag entirely — the value in
      // `parsed.flags` is ITS value, and handing it to the global listener
      // would act on something that was never the global flag.
      if (Command.flags?.some((flag) => flag.flagName === flagName)) continue
      if ((await listener(Command, this, parsed)) === true) return true
    }
    return false
  }

  /**
   * Build a command: inject, plug in the plumbing, hydrate. Everything up to
   * the lifecycle, shared by {@link create} and {@link #runCommand}.
   */
  async #build(
    Command: CommandClass,
    parsed: ParsedInput,
    isMain: boolean,
    ui: Ui,
  ): Promise<{ instance: CommandInstance; app: Application | undefined }> {
    // The application is resolved BEFORE the command is built: with one
    // available, the command goes through the container so constructor
    // dependencies are injected (Ace parity), and its lifecycle hooks are
    // invoked through `container.call` so `@inject()` works on them too.
    const app = await this.#resolveApp(Command)
    const instance: CommandInstance =
      app === undefined ? new Command() : await app.container.make<CommandInstance>(Command)

    Object.assign(instance, {
      logger: ui.logger,
      ui,
      kernel: this,
      colors: ui.colors,
      // `handle()` is the command line; `exec()` is another caller.
      isMain,
      prompt: this.#prompt ?? new Prompt(),
      // Ace exposes every parsed input, not only the declared ones.
      parsed,
      onTerminate: this.#onTerminate,
    })
    this.#attachApp(instance, Command, app)

    // Values after the plumbing, as Ace does: the command's own `hydrate()`
    // when it has one — a ported command may call it again, it is idempotent —
    // and a plain assignment for a class declared structurally, which has none.
    const hydrate = Reflect.get(instance, 'hydrate')
    if (typeof hydrate === 'function') Reflect.apply(hydrate, instance, [])
    else assignParsedValues(instance, Command.args ?? [], Command.flags ?? [], parsed)

    // The application is handed back rather than resolved twice: booting it is
    // not free, and `#resolveApp` is what starts it.
    return { instance, app }
  }

  /**
   * Build a command, ready to run — the default executor's `create`.
   *
   * @internal Public only because {@link commandExecutor} is a static object
   * and cannot reach the kernel's privates.
   */
  async buildCommand(
    Command: CommandClass,
    parsed: ParsedInput,
    context: { isMain: boolean; ui: Ui } = { isMain: false, ui: this.ui },
  ): Promise<CommandInstance> {
    const { instance, app } = await this.#build(Command, parsed, context.isMain, context.ui)
    // Kept off the instance: `this.app` throws by design when the command did
    // not ask for the application, and the lifecycle still needs to know
    // whether there is a container to call through.
    if (app !== undefined) this.#apps.set(instance, app)
    return instance
  }

  /**
   * Run `prepare`, `interact` and `run` — the default executor's `run`.
   *
   * `completed` is deliberately NOT here: it must run even when this throws,
   * which is the kernel's business, not the executor's.
   *
   * @internal See {@link buildCommand}.
   */
  async runLifecycle(command: CommandInstance): Promise<unknown> {
    await this.#invoke(command, 'prepare')
    await this.#invoke(command, 'interact')
    return this.#invoke(command, 'run')
  }

  /** Call a lifecycle hook, through the container when there is one. */
  async #invoke(
    command: CommandInstance,
    hook: 'prepare' | 'interact' | 'run' | 'completed',
  ): Promise<unknown> {
    if (typeof command[hook] !== 'function') return undefined
    const app = this.#apps.get(command)
    if (app === undefined) return command[hook]()
    return app.container.call(command, hook)
  }

  async #runCommand(
    Command: CommandClass,
    parsed: ParsedInput,
    isMain = false,
    ui: Ui = this.ui,
  ): Promise<ExecutedCommand> {
    const instance = await this.#executor.create(Command, parsed, this, { isMain, ui })
    const invoke = (hook: 'completed'): Promise<unknown> => this.#invoke(instance, hook)

    // Ace's order: prepare → interact → run → completed. `completed` runs even
    // when an earlier stage threw, and can mark the error handled.
    let failure: unknown
    let result: unknown
    await this.#emit(this.#hooks.executing, (handler) => handler(instance, isMain))
    try {
      // Traced: an APM agent subscribes to `ream.command.exec` and sees every
      // run without the kernel knowing it is watched. The payload is only built
      // when somebody listens.
      result = await (commandExec.hasSubscribers
        ? commandExec.tracePromise(() => Promise.resolve(this.#executor.run(instance, this)), {
            command: Command,
            commandInstance: instance,
            argv: parsed.args.map(String),
          })
        : this.#executor.run(instance, this))
    } catch (err) {
      failure = err
    }

    // Assigned before `completed()` so the hook can inspect them.
    const ran = Object.assign(instance, { error: failure, result })

    if (typeof ran.completed === 'function') {
      try {
        const handled = await invoke('completed')
        if (handled === true) ran.error = undefined
      } catch (err) {
        // `completed` is part of the lifecycle, so a throw from it is an
        // execution failure like any other — it must not escape and turn
        // `exec()` into a rejection. When an earlier stage had already failed,
        // that first error is kept as the `cause` rather than lost.
        ran.error =
          ran.error === undefined || !(err instanceof Error)
            ? err
            : Object.assign(err, { cause: err.cause ?? ran.error })
      }
    }

    // Ace's convention: a command that failed without setting its own code
    // exits 1.
    const scored = Object.assign(ran, {
      exitCode: typeof ran.exitCode === 'number' ? ran.exitCode : ran.error === undefined ? 0 : 1,
    })

    // Only when it finished: Ace runs `executed` after the executor returns, so
    // a throw skips it. A hook counting successes must not see a failure —
    // and `completed()` marking the error handled IS a finish.
    if (scored.error === undefined) {
      await this.#emit(this.#hooks.executed, (handler) => handler(scored, isMain))
    }

    // Attached rather than inherited: a command declared structurally by an
    // agnostic package never extends BaseCommand, and `exec()` promises these
    // to every caller. A class that defines its own keeps it — `Object.assign`
    // only fills what is missing here because we spread ours first.
    return Object.assign(scored, createAssertions(scored, ui), {
      toJSON: createSnapshot(scored, Command.commandName, Command.options ?? {}),
    })
  }

  /**
   * Run a command programmatically — Ace's `ace.exec()`.
   *
   * It REJECTS when the command fails, as Ace does: the error is recorded on
   * the command (`error`, `exitCode` 1) and then rethrown, so a caller cannot
   * mistake a failure for a success by forgetting to look. `process.exitCode`
   * is left alone — only the command line owns that.
   *
   * To inspect a failing command instead of catching, build it with
   * {@link create} and drive it yourself, or run it through `handle()` and read
   * {@link getMainCommand}.
   */
  async exec(
    commandName: string,
    argv: readonly string[] = [],
    options: { ui?: Ui } = {},
  ): Promise<ExecutedCommand> {
    if (this.#state === 'idle') await this.boot()
    if (this.#state === 'completed') {
      throw new ReamError(
        'E_CONSOLE_KERNEL_COMPLETED',
        `The kernel has finished; "${commandName}" cannot be run through it.`,
        { hint: 'Create a fresh kernel to execute more commands.' },
      )
    }

    const expanded = this.#expandAlias([commandName, ...argv])
    const [name, ...rest] = expanded
    const Command = await this.find(name ?? commandName)

    // A caller-supplied UI is what silences a command, or captures its output
    // without touching the kernel's own (Ace `exec(..., { ui })`).
    const parsed = this.#parse(Command, rest, [], false)
    this.#validate(Command, parsed)
    const command = await this.#runCommand(Command, parsed, false, options.ui)
    if (command.error !== undefined) throw command.error
    return command
  }

  /**
   * Build a command instance without running it (Ace `kernel.create`).
   *
   * Parsed, injected and hydrated — everything `exec()` does up to the
   * lifecycle. The escape hatch for driving a command by hand: run it with
   * `command.exec()` and inspect it whatever it does.
   */
  async create<T extends CommandClass>(
    Command: T,
    argv: readonly string[] = [],
  ): Promise<InstanceType<T>> {
    if (this.#state === 'idle') await this.boot()
    const { instance } = await this.#build(
      Command,
      this.#parse(Command, argv, [], false),
      false,
      this.ui,
    )
    // The instance IS of the class handed in — built by `new Command()` or by
    // the container from that same class. Typing it as the structural contract
    // would hide the command's own API from the caller who named it.
    return instance as InstanceType<T>
  }

  /** Is this name — or alias — dispatchable? Ace's `ace.hasCommand()`. */
  hasCommand(name: string): boolean {
    const known = (commandName: string): boolean =>
      this.#commands.has(commandName) || this.#pending.has(commandName)
    if (known(name)) return true
    const expansion = this.#aliases.get(name)
    return expansion !== undefined && known(expansion[0] ?? '')
  }

  /**
   * Give the command its application — booting first when it asked for it.
   *
   * When it did not, `this.app` is a throwing accessor rather than
   * `undefined`: a command that resolves a service without declaring
   * `startApp: true` gets a message naming the fix, instead of a
   * "cannot read properties of undefined" ten frames deep.
   */
  /**
   * Boot the application when the command asked for it, and hand it back so the
   * command can be built through the container.
   */
  async #resolveApp(Command: CommandClass): Promise<Application | undefined> {
    if (Command.options?.startApp !== true) return undefined

    if (this.#startApp === undefined) {
      throw new ReamError(
        'E_CONSOLE_NO_APP',
        `"${Command.commandName}" requires a booted application, but this kernel was created without one.`,
        { hint: 'Dispatch through the Ignitor console kernel rather than a bare Kernel instance.' },
      )
    }

    return this.#startApp()
  }

  #attachApp(instance: CommandInstance, Command: CommandClass, app: Application | undefined): void {
    if (app === undefined) {
      Object.defineProperty(instance, 'app', {
        configurable: true,
        get: () => {
          throw new ReamError(
            'E_CONSOLE_APP_NOT_STARTED',
            `"${Command.commandName}" accessed this.app without booting the application.`,
            { hint: `Add: static options: CommandOptions = { startApp: true }` },
          )
        },
      })
      return
    }

    Object.assign(instance, { app })
  }

  /**
   * Swap a leading alias for what it stands for. Only the first token is
   * considered: an alias is a command shorthand, not a general macro.
   */
  #expandAlias(argv: readonly string[]): readonly string[] {
    const [first, ...rest] = argv
    if (first === undefined) return argv
    const expansion = this.#aliases.get(first)
    return expansion === undefined ? argv : [...expansion, ...rest]
  }

  /**
   * Run a hook's handlers in registration order.
   *
   * The caller passes the invocation rather than the arguments, which keeps
   * every hook's payload typed — a single variadic `emit` would need a cast to
   * correlate the hook name with its parameters.
   */
  async #emit<H>(handlers: readonly H[], invoke: (handler: H) => unknown): Promise<void> {
    for (const handler of handlers) await invoke(handler)
  }

  /** The command's own flags, plus the global ones it did not redeclare. */
  #flagsFor(Command: CommandClass): FlagMetaData[] {
    const own = [...(Command.flags ?? [])]
    const declared = new Set(own.map((flag) => flag.flagName))
    return [...own, ...this.#globalFlags.filter((flag) => !declared.has(flag.flagName))]
  }

  /**
   * Move a global flag written BEFORE the command name to after it.
   *
   * `ream --no-ansi list` has to work — that is where a user naturally puts a
   * CLI-wide switch — but the command name has to be the first token for the
   * registry lookup. Moving them keeps ONE parser for global and command flags
   * alike, instead of a second, hand-rolled scan.
   */
  #hoistGlobalFlags(argv: readonly string[]): string[] {
    const leading: string[] = []
    const rest: string[] = [...argv]

    while (rest.length > 0) {
      const token = rest[0] as string
      if (token === '--' || !token.startsWith('-')) break

      const name = token.replace(/^--?(no-)?/, '').split('=')[0] ?? ''
      const meta = this.#globalFlags.find(
        (flag) => flag.flagName === name || flag.alias.includes(name),
      )
      if (meta === undefined) break

      leading.push(rest.shift() as string)
      // A value-taking flag written apart from its value takes the next token
      // with it, or the value would be read as the command name.
      if (meta.type !== 'boolean' && !token.includes('=') && rest[1] !== undefined) {
        leading.push(rest.shift() as string)
      }
    }

    if (leading.length === 0) return [...argv]
    const [command, ...args] = rest
    return command === undefined ? leading : [command, ...args, ...leading]
  }

  #reportUnknown(name: string): void {
    // Aliases are names the user can legitimately type, so a typo on one has to
    // be suggestible too.
    renderErrorWithSuggestions(this.logger, `Unknown command "${name}".`, [
      ...this.getCommandSuggestions(name).slice(0, 1),
    ])
    process.stderr.write(`  Run "${this.#binaryName} list" to see available commands.\n`)
    process.exitCode = 1
  }

  /**
   * `list` — commands grouped by namespace, as Ace does.
   *
   * `namespaces` narrows the output to those groups; an empty list shows
   * everything. `make` selects `make:*`, and the empty string the commands that
   * have no namespace at all.
   */
  printList(asJson = false, namespaces: readonly string[] = []): void {
    // Off the metadata, not the classes: listing the commands must not import
    // the ones a loader has only announced.
    const all = this.#allMetadata()
    const commands =
      namespaces.length === 0
        ? all
        : all.filter((command) => namespaces.includes(command.namespace ?? ''))

    if (asJson) {
      // The full metadata contract, not a three-field summary: tooling reads
      // this to build help, completions or a command palette.
      this.logger.log(JSON.stringify(commands, null, 2))
      return
    }

    this.logger.log(`\n${colourise('Usage:', 'yellow')} ${this.#binaryName} <command> [options]\n`)

    // What the CLI says about itself, when it was told anything (Ace
    // `kernel.info`): binary name, framework and app versions.
    if (this.info.size > 0) {
      for (const [label, value] of this.info) {
        this.logger.log(`  ${colourise(label, 'dim')}  ${String(value)}`)
      }
      this.logger.log('')
    }

    if (commands.length === 0) {
      this.logger.log('  No commands registered.\n')
      return
    }

    const width = Math.max(...commands.map((command) => command.commandName.length))
    const groups = new Map<string, SerializedCommand[]>()
    for (const command of commands) {
      const group = command.namespace ?? ''
      const bucket = groups.get(group)
      if (bucket === undefined) groups.set(group, [command])
      else bucket.push(command)
    }

    // Ungrouped commands first, then each namespace.
    for (const [group, entries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      this.logger.log(
        group === '' ? colourise('Available commands', 'yellow') : colourise(group, 'yellow'),
      )
      for (const command of entries) {
        const suffix =
          command.aliases.length === 0 ? '' : colourise(` [${command.aliases.join(', ')}]`, 'dim')
        this.logger.log(
          `  ${colourise(command.commandName.padEnd(width), 'green')}  ${command.description}${suffix}`,
        )
      }
      this.logger.log('')
    }
  }

  /**
   * Every alias pointing at this command — both `static aliases` and the rc
   * file's `commandsAliases`, which only differ in where they were declared.
   */
  #aliasesFor(commandName: string): string[] {
    const found: string[] = []
    for (const [alias, expansion] of this.#aliases) {
      if (expansion[0] === commandName) found.push(alias)
    }
    return found.sort((a, b) => a.localeCompare(b))
  }

  /** Every command name the kernel knows, loaded or merely announced. */
  #names(): string[] {
    return [...new Set([...this.#commands.keys(), ...this.#pending.keys()])]
  }

  /**
   * The metadata of every command, sorted by name.
   *
   * A loaded class wins over the announcement it came from: once imported, the
   * class IS the contract, and a stale manifest must not describe it.
   */
  #allMetadata(): SerializedCommand[] {
    const all = new Map<string, SerializedCommand>()
    for (const [commandName, pending] of this.#pending) {
      all.set(commandName, { ...pending.metadata, aliases: this.#aliasesFor(commandName) })
    }
    for (const command of this.#commands.values()) {
      all.set(command.commandName, this.#metadataFor(command))
    }
    return [...all.values()].sort((a, b) => a.commandName.localeCompare(b.commandName))
  }

  /**
   * A command's metadata with the aliases the KERNEL knows about — a command
   * declares its own, but the rc file can add more, and a consumer reading the
   * metadata has no way to find those on its own.
   */
  #metadataFor(command: CommandClass): SerializedCommand {
    return { ...serializeCommand(command), aliases: this.#aliasesFor(command.commandName) }
  }

  /** `<command> --help` — usage, arguments and flags for one command. */
  printCommandHelp(command: CommandClass | SerializedCommand): void {
    // Metadata is enough to describe a command, and it is what the `help`
    // command holds: explaining a command must not import it.
    const meta = typeof command === 'function' ? serializeCommand(command) : command
    const args = meta.args
    const flags = meta.flags

    const usage = [this.#binaryName, meta.commandName]
    for (const arg of args) {
      const label = arg.type === 'spread' ? `...${arg.argumentName}` : arg.argumentName
      usage.push(arg.required ? `<${label}>` : `[${label}]`)
    }
    if (flags.length > 0) usage.push('[options]')

    this.logger.log(`\n${colourise('Usage:', 'yellow')} ${usage.join(' ')}\n`)
    this.logger.log(`  ${meta.description}\n`)

    const help = meta.help
    if (help !== undefined) {
      // Ace substitutes `{{ binaryName }}` so a help block can show a runnable
      // example without hardcoding the binary's name.
      for (const line of Array.isArray(help) ? help : [help]) {
        this.logger.log(`  ${line.replace(/\{\{\s*binaryName\s*\}\}/g, this.#binaryName)}`)
      }
      this.logger.log('')
    }

    if (args.length > 0) {
      this.logger.log(colourise('Arguments', 'yellow'))
      const width = Math.max(...args.map((arg) => arg.argumentName.length))
      for (const arg of args) {
        const notes = [
          arg.required ? undefined : 'optional',
          arg.default === undefined ? undefined : `default: ${String(arg.default)}`,
        ].filter((note) => note !== undefined)
        const suffix = notes.length > 0 ? colourise(` (${notes.join(', ')})`, 'dim') : ''
        this.logger.log(
          `  ${colourise(arg.argumentName.padEnd(width), 'green')}  ${arg.description ?? ''}${suffix}`,
        )
      }
      this.logger.log('')
    }

    // The command's own flags, then the global ones under their own heading —
    // a flag every command accepts but that no help mentions is a flag nobody
    // discovers.
    this.#printFlags('Options', flags)
    this.#printFlags('Global flags', this.#globalFlags)
  }

  #printFlags(heading: string, flags: readonly FlagMetaData[]): void {
    if (flags.length > 0) {
      this.logger.log(colourise(heading, 'yellow'))
      const labels = flags.map((flag) => {
        const aliases = flag.alias.map((alias) => `-${alias}`).join(', ')
        // Booleans are always negatable; this only decides whether help says so.
        const negated =
          flag.type === 'boolean' && flag.showNegatedVariantInHelp === true
            ? ` | --no-${flag.flagName}`
            : ''
        return `${aliases === '' ? '' : `${aliases}, `}--${flag.flagName}${
          flag.type === 'boolean' ? '' : `=<${flag.type}>`
        }${negated}`
      })
      const width = Math.max(...labels.map((label) => label.length))
      flags.forEach((flag, index) => {
        const notes = [
          flag.required ? 'required' : undefined,
          flag.default === undefined ? undefined : `default: ${String(flag.default)}`,
        ].filter((note) => note !== undefined)
        const suffix = notes.length > 0 ? colourise(` (${notes.join(', ')})`, 'dim') : ''
        this.logger.log(
          `  ${colourise((labels[index] ?? '').padEnd(width), 'green')}  ${flag.description ?? ''}${suffix}`,
        )
      })
      this.logger.log('')
    }
  }
}

/**
 * Split an alias expansion into argv tokens, honouring quotes.
 *
 * A plain `split(/\s+/)` breaks `make:controller --name "Blog Post"` into four
 * tokens instead of three, so any alias carrying a value with a space was
 * unrepresentable. Backslash escapes the next character.
 */
function tokeniseExpansion(expansion: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false

  for (let i = 0; i < expansion.length; i++) {
    const char = expansion[i] as string

    if (char === '\\' && i + 1 < expansion.length) {
      current += expansion[++i]
      started = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (started) tokens.push(current)
  return tokens
}

/**
 * A command's metadata, whether or not it extends `BaseCommand`.
 *
 * A class declared structurally by an agnostic package has no `serialize()`, so
 * the fields are read off the statics it does carry.
 */
export function serializeCommand(command: CommandClass): SerializedCommand {
  const own = Reflect.get(command, 'serialize')
  if (typeof own === 'function') {
    const serialized: unknown = Reflect.apply(own, command, [])
    if (isSerialized(serialized)) return serialized
  }

  return {
    commandName: command.commandName,
    namespace: namespaceOf(command.commandName),
    description: command.description,
    help: command.help,
    aliases: [...(command.aliases ?? [])],
    options: { ...command.options },
    args: (command.args ?? []).map(({ parse: _p, ...rest }) => rest),
    flags: (command.flags ?? []).map(({ parse: _p, ...rest }) => rest),
  }
}

/** `make:controller` → `make`; a name without a colon has no namespace. */
function namespaceOf(commandName: string): string | null {
  const colon = commandName.indexOf(':')
  return colon === -1 ? null : commandName.slice(0, colon)
}

function isSerialized(value: unknown): value is SerializedCommand {
  return typeof value === 'object' && value !== null && 'commandName' in value
}

/**
 * The candidates close enough to `input` to be worth suggesting, nearest first.
 *
 * One ranking, used both by the "Did you mean?" line and by the public
 * suggestion methods — two implementations would eventually disagree about
 * what counts as close.
 */
function suggestFrom(input: string, candidates: readonly string[]): string[] {
  const threshold = Math.max(2, Math.floor(input.length / 3))
  return candidates
    .map((candidate) => ({ candidate, score: distance(input, candidate) }))
    .filter(({ score }) => score <= threshold)
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .map(({ candidate }) => candidate)
}

function distance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, index) => index)

  for (let i = 1; i < rows; i++) {
    const current = [i]
    for (let j = 1; j < cols; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const insertion = (current[j - 1] ?? 0) + 1
      const deletion = (previous[j] ?? 0) + 1
      current[j] = Math.min(substitution, insertion, deletion)
    }
    previous = current
  }

  return previous[cols - 1] ?? 0
}

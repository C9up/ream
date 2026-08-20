/**
 * `consoleApp` — the programmatic face of the console.
 *
 * The CLI is not the only caller: a test wants to run a command and inspect the
 * result, a controller may want to trigger one, a script may want to check a
 * command exists before calling it. Spawning a process for that is both slow
 * and untestable.
 *
 *   import consoleApp from '@c9up/ream/services/console'
 *
 *   const command = await consoleApp.exec('make:controller', ['user', '--resource'])
 *   command.exitCode  // 0 on success, 1 on an unhandled failure
 *   command.result    // whatever run() returned
 *   command.error     // the failure, when one survived completed()
 */

import { ReamError } from '../errors/ReamError.js'
import type { Ui } from './cliui.js'
import type { Kernel, KernelState } from './Kernel.js'
import type { CommandClass, CommandInstance, ExecutedCommand, SerializedCommand } from './types.js'

export interface ConsoleOptions {
  kernel: Kernel
  /**
   * Loads the application's commands into the kernel. Called once, on first
   * use — discovery reads the filesystem and imports modules, which is too much
   * to do at every `hasCommand()`.
   */
  load: () => Promise<void>
}

export class Console {
  readonly #kernel: Kernel
  readonly #load: () => Promise<void>
  #booting: Promise<void> | undefined
  #booted = false

  constructor(options: ConsoleOptions) {
    this.#kernel = options.kernel
    this.#load = options.load
  }

  /**
   * Load the commands if that has not happened yet.
   *
   * Idempotent, and safe under concurrent calls: the in-flight promise is
   * shared, so two parallel `exec()` calls do not each import every command.
   */
  async boot(): Promise<void> {
    this.#booting ??= this.#load().then(() => {
      this.#booted = true
    })
    await this.#booting
  }

  /** Run a command and return it, carrying `exitCode`, `result` and `error`. */
  async exec(
    commandName: string,
    argv: readonly string[] = [],
    options: { ui?: Ui } = {},
  ): Promise<ExecutedCommand> {
    await this.boot()
    return this.#kernel.exec(commandName, argv, options)
  }

  /**
   * Does a command (or alias) by this name exist?
   *
   * Synchronous, as in Console — `await consoleApp.boot()` then `if (consoleApp.hasCommand(…))`.
   * An async version would be a trap: a Promise is always truthy, so Adonis
   * code copied over would take every branch.
   *
   * Calling it before `boot()` throws rather than answering `false`: an
   * unloaded registry cannot tell "no such command" from "not looked yet", and
   * a silent `false` is exactly the failure this signature exists to avoid.
   */
  hasCommand(name: string): boolean {
    this.#assertBooted('hasCommand')
    return this.#kernel.hasCommand(name)
  }

  /** The metadata of every registered command. Requires {@link boot} too. */
  getCommands(): SerializedCommand[] {
    this.#assertBooted('getCommands')
    return this.#kernel.getCommands()
  }

  /**
   * The rest of Console's introspection surface, relayed as-is.
   *
   * All of it reads the registry, so all of it needs {@link boot} first —
   * answering from an empty registry would be worse than the error, since
   * "no such command" and "commands not loaded yet" are indistinguishable to
   * the caller.
   */
  getCommand(commandName: string): SerializedCommand | null {
    this.#assertBooted('getCommand')
    return this.#kernel.getCommand(commandName)
  }

  getNamespaceCommands(namespace?: string): SerializedCommand[] {
    this.#assertBooted('getNamespaceCommands')
    return this.#kernel.getNamespaceCommands(namespace)
  }

  getNamespaces(): string[] {
    this.#assertBooted('getNamespaces')
    return this.#kernel.getNamespaces()
  }

  getAliases(): string[] {
    this.#assertBooted('getAliases')
    return this.#kernel.getAliases()
  }

  getAliasCommand(alias: string): SerializedCommand | null {
    this.#assertBooted('getAliasCommand')
    return this.#kernel.getAliasCommand(alias)
  }

  getCommandAliases(commandName: string): string[] {
    this.#assertBooted('getCommandAliases')
    return this.#kernel.getCommandAliases(commandName)
  }

  getCommandSuggestions(name: string): string[] {
    this.#assertBooted('getCommandSuggestions')
    return this.#kernel.getCommandSuggestions(name)
  }

  getNamespaceSuggestions(name: string): string[] {
    this.#assertBooted('getNamespaceSuggestions')
    return this.#kernel.getNamespaceSuggestions(name)
  }

  /** The kernel's lifecycle stage — Console `getState()`. */
  getState(): KernelState {
    return this.#kernel.getState()
  }

  /** The command run when none is named. */
  getDefaultCommand(): CommandClass {
    this.#assertBooted('getDefaultCommand')
    return this.#kernel.getDefaultCommand()
  }

  /** The command invoked from the command line, once it has been built. */
  getMainCommand(): CommandInstance | undefined {
    return this.#kernel.getMainCommand()
  }

  /**
   * Resolve a command class by name or alias, throwing when there is none.
   * Loads the commands first, like {@link exec}.
   */
  async find(commandName: string): Promise<CommandClass> {
    await this.boot()
    return this.#kernel.find(commandName)
  }

  #assertBooted(method: string): void {
    if (this.#booted) return
    throw new ReamError(
      'E_CONSOLE_NOT_BOOTED',
      `consoleApp.${method}() was called before the commands were loaded.`,
      { hint: 'Await consoleApp.boot() first — consoleApp.exec() does it for you.' },
    )
  }

  /** The underlying kernel, for anything the façade does not cover. */
  get kernel(): Kernel {
    return this.#kernel
  }
}

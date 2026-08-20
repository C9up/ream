/**
 * BaseCommand — the class application commands extend (Console parity).
 *
 * Everything the kernel needs sits on the STATIC side (`commandName`,
 * `description`, `options`, and the `args` / `flags` metadata written by the
 * decorators), so extending this class is a convenience, not a requirement:
 * it supplies `this.logger`, `this.prompt`, `this.app` and the `exitCode`
 * contract. Packages that must not depend on `@c9up/ream` declare the same
 * statics on a plain class instead.
 *
 *   export default class Provision extends BaseCommand {
 *     static commandName = 'provision'
 *     static description = 'Create the owner account'
 *     static options: CommandOptions = { startApp: true }
 *
 *     @flags.string({ description: 'Owner email', required: true })
 *     declare email: string
 *
 *     async run() {
 *       const users = await this.app.container.resolve('users')
 *       await users.createOwner(this.email)
 *       this.logger.success(`Owner created: ${this.email}`)
 *     }
 *   }
 */

import type { Application } from '../Application.js'
import { createAssertions } from './assertions.js'
import type { Colors, Logger, Ui } from './cliui.js'
import { assertArgumentOrder, buildArgument, buildFlag } from './decorators.js'
import type { Kernel } from './Kernel.js'
import { assignParsedValues, validateParsed } from './parser.js'
import type { Prompt } from './prompts.js'
import type {
  ArgumentMetaData,
  ArgumentsParserOptions,
  CommandOptions,
  CommandSnapshot,
  FlagMetaData,
  FlagsParserOptions,
  ParsedInput,
  SerializedCommand,
} from './types.js'

export abstract class BaseCommand {
  /** Name typed on the command line, e.g. `provision` or `make:controller`. */
  static commandName = ''

  /** One-line summary shown by `list`. */
  static description = ''

  /**
   * Alternative names this command answers to (Console `static aliases`). Unlike
   * `commandsAliases` in the rc file, these travel with the command itself.
   */
  static aliases: readonly string[] = []

  /** Longer text shown under the usage line by `<command> --help`. */
  static help?: string | string[]

  static options: CommandOptions = {}

  /**
   * Written by the `@args` / `@flags` decorators. Declared here so a subclass
   * that uses neither still satisfies the dispatch contract, and so the
   * decorators have an inherited list to copy from.
   */
  static args: readonly ArgumentMetaData[] = []
  static flags: readonly FlagMetaData[] = []

  /**
   * Assigned by the kernel before `run()`. Declared with `declare` so no class
   * field is emitted — under `target: ES2022` a real field would be
   * re-initialised to `undefined` at construction and wipe the assignment.
   */
  declare logger: Logger
  /** Tables, stickers, instructions, tasks — and the raw-mode switch. */
  declare ui: Ui
  /** Chainable ANSI helpers: `this.colors.green('DONE')`. */
  declare colors: Colors
  declare prompt: Prompt

  /**
   * The booted application. Only meaningful when the command sets
   * `options.startApp` — otherwise the kernel never boots, and reading this is
   * a programming error the kernel reports rather than a silent `undefined`.
   */
  declare app: Application

  /**
   * The kernel that dispatched this command (Console parity).
   *
   * Assigned for every command, booted app or not: it is the registry, and a
   * command that inspects or lists its siblings — `list` is the built-in
   * example — has nowhere else to read them from.
   */
  declare kernel: Kernel

  /**
   * Every parsed input, as Console exposes it: `this.parsed.args` /
   * `this.parsed.flags`. The declared ones are also assigned to their
   * properties; this is the whole picture, including flags accepted through
   * `allowUnknownFlags`.
   */
  declare parsed: ParsedInput

  /** Set it to make the process exit non-zero without throwing. */
  exitCode?: number

  /** What `run()` returned — filled by the kernel (Console `command.result`). */
  result?: unknown

  /**
   * The error thrown by `prepare` / `interact` / `run`, assigned before
   * `completed()` runs so the hook can inspect it (Console parity).
   */
  error?: unknown

  /** Assigned by the kernel — see {@link terminate}. */
  protected declare onTerminate?: () => void | Promise<void>

  /**
   * Lifecycle hooks, run in this order around `run()`: `prepare`, `interact`,
   * `run`, then `completed` — which runs even when one of the earlier stages
   * threw. Returning `true` from `completed()` marks the error handled, so the
   * kernel stops propagating it.
   */
  // Parameters are allowed: the container injects them (`@inject()` on a
  // lifecycle method), and a no-arg signature rejects those commands.
  prepare?(...args: never[]): void | Promise<void>
  interact?(...args: never[]): void | Promise<void>
  // biome-ignore lint/suspicious/noConfusingVoidType: Console contract — returning `true` marks the error handled, returning nothing is the normal case
  completed?(...args: never[]): boolean | void | Promise<boolean | void>

  /**
   * Shut down a `staysAlive` command. Without it a long-running command has no
   * way to hand control back — the kernel deliberately does not tear the app
   * down for those.
   */
  async terminate(): Promise<void> {
    await this.onTerminate?.()
  }

  /** Has {@link boot} run for THIS class — not for one of its ancestors. */
  static booted = false

  /**
   * Give this class its OWN copy of the inherited static declarations
   * (Console `boot`).
   *
   * Without it, `Child.args.push(...)` would append to the array the parent
   * declared, and every command in the hierarchy would share one list. Called
   * by everything that reads or writes those statics, so it is normally
   * invisible; it is public because ported Console code calls it directly.
   */
  static boot(): void {
    if (Object.hasOwn(this, 'booted') && this.booted === true) return
    this.booted = true
    // Only the mutable declarations are copied. Console also re-assigns the scalar
    // statics (name, description, help); for a string, an own copy and an
    // inherited one are indistinguishable — the line would read as a bug.
    this.args = [...this.args]
    this.flags = [...this.flags]
    this.aliases = [...this.aliases]
    this.options = { staysAlive: false, allowUnknownFlags: false, ...this.options }
  }

  /**
   * Declare an argument without a decorator (Console `defineArgument`).
   *
   * The decorators are the ergonomic form, but a command built at runtime — or
   * one in a package that must not import the framework — needs a plain call.
   */
  static defineArgument(name: string, options: Partial<ArgumentMetaData> = {}): void {
    this.boot()
    const list: ArgumentMetaData[] = [...this.args]
    // Built by the same function the decorators use: a field added on one path
    // and forgotten on the other is a silent divergence, not a compile error.
    const argument = buildArgument(name, options)

    // Console's two ordering rules, shared with the decorators — see
    // `assertArgumentOrder`. They are not pedantry: a spread argument eats the
    // tail, so nothing after it can ever be filled, and a required argument
    // behind an optional one can only be reached by passing the optional one,
    // which makes "required" a lie.
    assertArgumentOrder(list, argument)

    list.push(argument)
    this.args = list
  }

  /** Declare a flag without a decorator (Console `defineFlag`). */
  static defineFlag(name: string, options: Partial<FlagMetaData> = {}): void {
    this.boot()
    const list: FlagMetaData[] = [...this.flags]
    list.push(buildFlag(name, options))
    this.flags = list
  }

  /**
   * The command's metadata as plain data (Console `serialize`).
   *
   * What `ream list --json` and any tooling reads, without having to know how
   * the decorators stored it.
   */
  static serialize(): SerializedCommand {
    this.boot()
    // `parse` is a function: keeping it would make this object look JSON-safe
    // while quietly losing a field the moment it is stringified.
    const withoutParse = <T extends { parse?: unknown }>(entry: T): Omit<T, 'parse'> => {
      const { parse: _dropped, ...rest } = entry
      return rest
    }

    const colon = this.commandName.indexOf(':')

    return {
      commandName: this.commandName,
      namespace: colon === -1 ? null : this.commandName.slice(0, colon),
      description: this.description,
      help: this.help,
      aliases: [...this.aliases],
      options: { ...this.options },
      args: this.args.map(withoutParse),
      flags: this.flags.map(withoutParse),
    }
  }

  /**
   * How this command's inputs are parsed, grouped by type (Console
   * `getParserOptions`).
   *
   * Ream's parser reads the declarations directly, so nothing internal calls
   * this; it exists because Console code inspects the shape — and it is derived
   * from the same metadata, so it cannot describe something the parser would
   * not do.
   */
  static getParserOptions(options?: Partial<FlagsParserOptions>): {
    flagsParserOptions: FlagsParserOptions
    argumentsParserOptions: ArgumentsParserOptions[]
  } {
    this.boot()

    const flagsParserOptions: FlagsParserOptions = {
      all: [],
      string: [],
      boolean: [],
      number: [],
      array: [],
      alias: {},
      count: [],
      coerce: {},
      default: {},
      ...options,
    }

    for (const flag of this.flags) {
      flagsParserOptions.all.push(flag.flagName)
      if (flag.alias.length > 0) flagsParserOptions.alias[flag.flagName] = [...flag.alias]
      if (flag.parse !== undefined) {
        flagsParserOptions.coerce[flag.flagName] = flag.parse as (value: never) => unknown
      }
      if (flag.default !== undefined) flagsParserOptions.default[flag.flagName] = flag.default
      flagsParserOptions[flag.type].push(flag.flagName)
    }

    return {
      flagsParserOptions,
      argumentsParserOptions: this.args.map((arg) => ({
        type: arg.type,
        default: arg.default,
        parse: arg.parse,
      })),
    }
  }

  /**
   * Check a parsed input against this command's declarations (Console `validate`).
   *
   * The parser enforces the same rules while parsing, so calling this on its
   * output always passes. It is here for the case Console documents: an input built
   * by hand, which has never been through a parser.
   *
   * Positional values are accepted as a list (Console's shape) or keyed by property
   * name (what `this.parsed.args` holds), so the same call works from both.
   */
  static validate(parsed: {
    args: readonly unknown[] | Record<string, unknown>
    flags?: Record<string, unknown>
    unknownFlags?: readonly string[]
  }): void {
    this.boot()
    // The kernel applies the same rules between parsing and running — see
    // `validateParsed`. One implementation, so a hand-built input is held to
    // exactly what the command line is held to.
    validateParsed(parsed, {
      args: this.args,
      flags: this.flags,
      allowUnknownFlags: this.options.allowUnknownFlags,
      commandName: this.commandName,
    })
  }

  /**
   * Assign the parsed values to their properties (Console `hydrate`).
   *
   * Idempotent: the kernel calls it before `run()`, and a ported command may
   * call it again without the values being recomputed.
   */
  hydrate(): void {
    if (this.hydrated) return
    const commandClass = Object.getPrototypeOf(this).constructor
    if (!isDeclaring(commandClass)) {
      throw new Error('hydrate() requires a command class carrying the static contract')
    }

    // One hydration path, shared with the kernel — see `assignParsedValues`.
    // By declaration, not by copying the parsed bag: positionals are read BY
    // POSITION and flags by their CLI name, so `this.name` is filled whichever
    // shape the input came in.
    assignParsedValues(this, commandClass.args, commandClass.flags, this.parsed)

    this.hydrated = true
  }

  /** Set once {@link hydrate} has run. */
  protected hydrated = false

  /**
   * Hydrate, then run — Console's instance-level `exec()`.
   *
   * Deliberately NOT the kernel's `exec()`: this one runs `run()` alone and
   * rethrows, while the kernel drives the whole lifecycle (`prepare`,
   * `interact`, `completed`) and reports the failure on the command instead.
   */
  async exec(): Promise<unknown> {
    this.hydrate()
    try {
      this.result = await this.run()
      this.exitCode = this.exitCode ?? 0
      return this.result
    } catch (error) {
      this.error = error
      this.exitCode = this.exitCode ?? 1
      throw error
    }
  }

  /** The statics, readable from the instance (Console parity). */
  get commandName(): string {
    return Object.getPrototypeOf(this).constructor.commandName
  }

  get options(): CommandOptions {
    return Object.getPrototypeOf(this).constructor.options
  }

  get args(): readonly ArgumentMetaData[] {
    return Object.getPrototypeOf(this).constructor.args
  }

  get flags(): readonly FlagMetaData[] {
    return Object.getPrototypeOf(this).constructor.flags
  }

  /**
   * A snapshot of THIS execution (Console `toJSON`): what the command received and
   * what it produced.
   *
   * Distinct from the static {@link serialize}, which describes the command's
   * contract. Returning the metadata here would drop `exitCode`, `result` and
   * `error` — exactly what a test or an integration reads after running it.
   */
  toJSON(): CommandSnapshot {
    // Not named `constructor`: that shadows the global and biome rejects it.
    const commandClass = Object.getPrototypeOf(this).constructor
    if (!isSerializable(commandClass)) {
      throw new Error('toJSON() requires a command class carrying the static contract')
    }
    const meta = commandClass.serialize()

    return {
      commandName: meta.commandName,
      options: meta.options,
      // Positional VALUES as a list (Console's shape); flags stay keyed.
      args: [...(this.parsed?.args ?? [])],
      flags: this.parsed?.flags ?? {},
      error: this.error,
      result: this.result,
      exitCode: this.exitCode,
    }
  }

  /**
   * Was this command the one invoked on the command line, rather than one
   * another command called through `consoleApp.exec()`? Assigned by the kernel.
   */
  declare isMain: boolean

  abstract run(...args: never[]): unknown

  // ─── Test assertions (Console parity) ───────────────────────────
  //
  // They live on the command because that is where a test holds the result,
  // but the implementation is the kernel's: a command the kernel ran carries
  // assertions ATTACHED by it (a class declared structurally never extends
  // this one), and two copies of "did the table print this row?" is how the
  // two answers end up disagreeing — which is exactly what happened.

  /** The command finished with exit code 0. */
  assertSucceeded(): void {
    createAssertions(this, this.ui).assertSucceeded()
  }

  /** The command finished with a non-zero exit code. */
  assertFailed(): void {
    createAssertions(this, this.ui).assertFailed()
  }

  assertExitCode(expected: number): void {
    createAssertions(this, this.ui).assertExitCode(expected)
  }

  assertNotExitCode(unexpected: number): void {
    createAssertions(this, this.ui).assertNotExitCode(unexpected)
  }

  /**
   * A line equal to `message` was logged. Pass a stream to require it went
   * there — a warning belongs on stderr, and asserting that is the point.
   */
  assertLog(message: string, stream?: 'stdout' | 'stderr'): void {
    createAssertions(this, this.ui).assertLog(message, stream)
  }

  assertLogMatches(pattern: RegExp, stream?: 'stdout' | 'stderr'): void {
    createAssertions(this, this.ui).assertLogMatches(pattern, stream)
  }

  /** Every expected row was rendered — the header counts as one (Console). */
  assertTableRows(expected: readonly (readonly string[])[]): void {
    createAssertions(this, this.ui).assertTableRows(expected)
  }
}

/**
 * The class carries the declarations `hydrate()` reads. Checked rather than
 * assumed: a command may be declared structurally, and reading `args` off
 * something that has none would silently hydrate nothing.
 */
function isDeclaring(
  value: unknown,
): value is { args: readonly ArgumentMetaData[]; flags: readonly FlagMetaData[] } {
  return (
    typeof value === 'function' &&
    Array.isArray(Reflect.get(value, 'args')) &&
    Array.isArray(Reflect.get(value, 'flags'))
  )
}

function isSerializable(value: unknown): value is { serialize(): SerializedCommand } {
  return (
    typeof value === 'function' &&
    'serialize' in value &&
    typeof Reflect.get(value, 'serialize') === 'function'
  )
}

/**
 * Console command contract — the STATIC shape the kernel dispatches against.
 *
 * Ace parity: a command is a class carrying its own metadata as statics
 * (`commandName`, `description`, `options`) plus the argument/flag metadata
 * collected by the `@args` / `@flags` decorators. The kernel never requires the
 * class to extend {@link BaseCommand}: ANY class exposing these statics is
 * dispatchable.
 *
 * That is deliberate. Framework-agnostic packages (atlas and friends) must not
 * import `@c9up/ream` — the same constraint that made the old `AtlasCommand`
 * duck-type the `{ name, description, run }` object shape. Keeping the contract
 * on statics lets those packages declare classes with typed args/flags and stay
 * dependency-free.
 */

/** Per-command behaviour switches. Mirrors Ace's `CommandOptions`. */
export interface CommandOptions {
  /**
   * Boot the application (providers, DB, container) before `run()`.
   *
   * Defaults to `false`, as in Ace: a scaffolding command has no business
   * opening a database connection. Commands that resolve services from the
   * container must opt in.
   */
  startApp?: boolean

  /**
   * Keep the process alive after `run()` resolves (long-running commands such
   * as a queue worker). Defaults to `false` — the kernel tears the app down and
   * lets the process exit.
   */
  staysAlive?: boolean

  /**
   * Accept flags the command did not declare instead of failing. Off by
   * default so a typo (`--warm` for `--warn`) is reported, not swallowed.
   */
  allowUnknownFlags?: boolean
}

/** Metadata recorded by an `@args.*` decorator. */
export interface ArgumentMetaData {
  type: 'string' | 'spread'
  /** Class property the parsed value is assigned to. */
  propertyName: string
  /** Name shown in help output (defaults to the dash-cased property name). */
  argumentName: string
  description?: string
  required: boolean
  default?: string | string[]
  /**
   * Accept an empty value (`ream greet ""`). Rejected by default, as in Ace: an
   * empty positional is nearly always a shell variable that did not expand.
   */
  allowEmptyValue?: boolean
  /** Transforms/validates the raw value before it is assigned (Ace `parse`). */
  parse?: (value: string | string[]) => unknown
}

/** Metadata recorded by a `@flags.*` decorator. */
export interface FlagMetaData {
  type: 'string' | 'boolean' | 'number' | 'array'
  /** Class property the parsed value is assigned to. */
  propertyName: string
  /** Name used on the command line (defaults to the dash-cased property name). */
  flagName: string
  description?: string
  /** Single-character shorthands, e.g. `['r']` for `-r`. */
  alias: string[]
  default?: string | string[] | number | boolean
  required: boolean
  /**
   * Accept `--name` with nothing behind it, as an empty value rather than an
   * error (Ace `allowEmptyValue`).
   */
  allowEmptyValue?: boolean
  /** Transforms/validates the coerced value before it is assigned (Ace `parse`). */
  parse?: (value: string | string[] | number | boolean) => unknown
  /** List `--no-<flag>` alongside the flag in help (booleans only). */
  showNegatedVariantInHelp?: boolean
}

/** What the kernel produces from argv and assigns onto the command instance. */
/**
 * The parsed CLI input, in the shape Ace publishes it.
 *
 * Positionals are a LIST, in declaration order, and flags are keyed by their
 * COMMAND-LINE name — `parsed.flags['user-email']`, not `parsed.flags.userEmail`.
 * The property names are what the values are assigned TO on the command; the
 * parsed bag describes what was typed.
 */
export interface ParsedInput {
  args: unknown[]
  flags: Record<string, unknown>
  /**
   * Names of the flags that were passed but not declared (Ace
   * `this.parsed.unknownFlags`). Their values are in {@link flags}; this is the
   * list a command inspects to know what it was handed but does not know about.
   */
  unknownFlags: string[]
  /**
   * Positionals beyond what the command declared.
   *
   * Normally none: an undeclared positional is an error. A command running with
   * `allowUnknownFlags` is a proxy, so they are kept here instead of being
   * dropped — forwarding them is the whole point of such a command.
   */
  extraArgs: string[]
  /** Ace's name for {@link extraArgs} — the same array, not a copy. */
  _: string[]
  /**
   * The arguments node itself was started with (Ace `nodeArgs`), filled only
   * for the command invoked from the command line.
   */
  nodeArgs: string[]
}

/**
 * The instance side of a command.
 *
 * Only `run()` is required. The lifecycle hooks are optional: the kernel calls
 * whichever the command defines, in Ace's order — prepare, interact, run,
 * completed.
 */
export interface CommandInstance {
  /**
   * Whatever it returns becomes `result` on the executed command.
   *
   * Parameters are allowed: the container injects them (Ace `@inject()` on a
   * lifecycle method), and a no-arg signature would reject those commands.
   */
  run(...args: never[]): unknown
  prepare?(...args: never[]): void | Promise<void>
  interact?(...args: never[]): void | Promise<void>
  /** Returning `true` marks the error handled, stopping its propagation. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Ace contract — returning `true` marks the error handled, returning nothing is the normal case
  completed?(...args: never[]): boolean | void | Promise<boolean | void>
  /** Set by the command to force a code; the kernel fills it in otherwise. */
  exitCode?: number
  /** Filled by the kernel before `completed()` runs. */
  error?: unknown
  /** Filled by the kernel with what `run()` returned. */
  result?: unknown
}

/**
 * A command's metadata as plain data (Ace `serialize`).
 *
 * JSON-safe on purpose: the `parse` callbacks carried by the live metadata are
 * dropped, so this can be printed, cached or sent over a wire without a
 * function silently disappearing at the boundary.
 */
/**
 * How one positional argument is parsed (Ace `ArgumentsParserOptions`).
 *
 * Derived from the declarations by `BaseCommand.getParserOptions()`. Ream's own
 * parser reads the declarations directly; this shape exists so code ported from
 * Ace — which inspects it — keeps working.
 */
export interface ArgumentsParserOptions {
  type: 'string' | 'spread'
  default?: string | string[]
  parse?: (value: string | string[]) => unknown
}

/** How the flags are parsed, grouped by type (Ace `FlagsParserOptions`). */
export interface FlagsParserOptions {
  all: string[]
  string: string[]
  boolean: string[]
  number: string[]
  array: string[]
  /** Flag name → its single-character shorthands. */
  alias: Record<string, string[]>
  count: string[]
  /** Flag name → its `parse` callback. */
  coerce: Record<string, (value: never) => unknown>
  default: Record<string, unknown>
}

export interface SerializedCommand {
  commandName: string
  /**
   * Where the command was found, relative to the directory it was loaded from.
   *
   * Set by loaders that read files, and by nothing else: it is what lets a
   * generated manifest import a command without scanning anything.
   */
  filePath?: string
  /** The part before `:` — `make` for `make:controller`, null when there is none. */
  namespace: string | null
  description: string
  help?: string | string[]
  aliases: string[]
  options: CommandOptions
  args: Array<Omit<ArgumentMetaData, 'parse'>>
  flags: Array<Omit<FlagMetaData, 'parse'>>
}

/**
 * A snapshot of a command that has run (Ace `toJSON`).
 *
 * Unlike {@link SerializedCommand} this is about one execution: the values it
 * received and what it produced. `args` / `flags` are the parsed VALUES, not
 * their declarations.
 */
export interface CommandSnapshot {
  commandName: string
  options: CommandOptions
  /** Positional VALUES in declaration order — Ace exposes a list here. */
  args: unknown[]
  flags: Record<string, unknown>
  error: unknown
  result: unknown
  exitCode: number | undefined
}

/**
 * A command that has run.
 *
 * The three outcome fields are guaranteed here, which is what `exec()` returns:
 * without it the documented `command.exitCode` / `.result` / `.error` does not
 * typecheck for a caller, and the only way to read them is a reflective escape
 * hatch — which is exactly what the tests had ended up doing.
 */
/**
 * Assertions available on a command that has run.
 *
 * Part of what `exec()` returns, so a caller can use them without the type
 * hiding what exists at runtime. The kernel attaches them to every command it
 * runs, including one that does not extend `BaseCommand`.
 */
export interface CommandAssertions {
  assertSucceeded(): void
  assertFailed(): void
  assertExitCode(expected: number): void
  assertNotExitCode(unexpected: number): void
  assertLog(message: string, stream?: 'stdout' | 'stderr'): void
  assertLogMatches(pattern: RegExp, stream?: 'stdout' | 'stderr'): void
  assertTableRows(expected: readonly (readonly string[])[]): void
}

export interface ExecutedCommand extends CommandInstance, CommandAssertions {
  exitCode: number
  error: unknown
  result: unknown
  /** A snapshot of this execution (Ace `toJSON`). */
  toJSON(): CommandSnapshot
}

/**
 * The static side. `args` / `flags` are optional so a command with neither
 * still satisfies the contract without declaring empty arrays.
 */
export interface CommandClass {
  // Not `new ()`: a command built through the container receives its injected
  // dependencies, and a zero-arg signature rejects every such class.
  new (...args: never[]): CommandInstance
  commandName: string
  description: string
  /** Alternative names the command also answers to (Ace `static aliases`). */
  aliases?: readonly string[]
  options?: CommandOptions
  args?: readonly ArgumentMetaData[]
  flags?: readonly FlagMetaData[]
  /** Longer help text printed under the usage line by `<cmd> --help`. */
  help?: string | string[]
}

/** Narrowing guard used by the kernel when loading modules. */
export function isCommandClass(value: unknown): value is CommandClass {
  if (typeof value !== 'function') return false
  const candidate = value as Partial<CommandClass>
  return (
    typeof candidate.commandName === 'string' &&
    candidate.commandName.length > 0 &&
    typeof candidate.description === 'string'
  )
}

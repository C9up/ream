/**
 * argv parser for console commands.
 *
 * Metadata-driven, unlike the naive splitter it replaces: knowing a flag's
 * declared type is what makes `--email hugo@example.com` work. Without it the
 * parser cannot tell a value-taking flag from a boolean one, so it has to treat
 * every `--flag` as `true` and let the value fall through to the positionals —
 * which is exactly how the previous implementation silently dropped arguments.
 *
 * Supported forms (Console parity):
 *   --flag=value   --flag value   --flag (boolean)   --no-flag (boolean false)
 *   -f value       -f             -abc (grouped boolean aliases)
 *   --             everything after it is positional, never a flag
 *   repeated flags accumulate for `@flags.array()`
 */

import { ReamError } from '../errors/ReamError.js'
import type { ArgumentMetaData, FlagMetaData, ParsedInput } from './types.js'

export interface ParseOptions {
  args?: readonly ArgumentMetaData[]
  flags?: readonly FlagMetaData[]
  allowUnknownFlags?: boolean
  /** Command name, used to make error messages point at the right command. */
  commandName?: string
  /**
   * Check the required inputs while parsing. `false` parses leniently and
   * leaves that to {@link validateParsed}.
   *
   * The kernel parses leniently on purpose: Console validates AFTER the global-flag
   * listeners have run, which is what lets `--help` work on a command whose
   * flags are required.
   */
  validate?: boolean
}

/** A flag token resolved against the declared metadata. */
interface RawFlag {
  meta: FlagMetaData
  /** `undefined` means "no inline value" — a boolean, or a value still to come. */
  value?: string
}

/**
 * The parser as an object (Console `Parser`).
 *
 * Same work as {@link parseArgv}, held in a shape that can be passed around and
 * reused — which is how Console's kernel and its ported code hold it.
 */
export class Parser {
  readonly #options: ParseOptions

  constructor(options: ParseOptions = {}) {
    this.#options = options
  }

  parse(argv: readonly string[] | string): ParsedInput {
    return parseArgv(
      typeof argv === 'string' ? argv.split(' ').filter(Boolean) : argv,
      this.#options,
    )
  }
}

export function parseArgv(argv: readonly string[], options: ParseOptions = {}): ParsedInput {
  const declaredFlags = options.flags ?? []
  const declaredArgs = options.args ?? []
  const where = options.commandName ? ` for "${options.commandName}"` : ''

  const byName = new Map<string, FlagMetaData>()
  const byAlias = new Map<string, FlagMetaData>()
  for (const flag of declaredFlags) {
    byName.set(flag.flagName, flag)
    for (const alias of flag.alias) byAlias.set(alias, flag)
  }

  const positionals: string[] = []
  /** Collected per property so repeated flags can accumulate into arrays. */
  const collected = new Map<string, Array<string | boolean>>()
  const unknown: Record<string, string | boolean> = {}

  const push = (meta: FlagMetaData, value: string | boolean): void => {
    const existing = collected.get(meta.propertyName)
    if (existing) existing.push(value)
    else collected.set(meta.propertyName, [value])
  }

  /** Record the flag as seen without attaching a value to it. */
  const mention = (meta: FlagMetaData): void => {
    if (!collected.has(meta.propertyName)) collected.set(meta.propertyName, [])
  }

  let sawTerminator = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (sawTerminator) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      sawTerminator = true
      continue
    }

    // --long, --long=value, --no-long
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const name = eq === -1 ? body : body.slice(0, eq)
      const inline = eq === -1 ? undefined : body.slice(eq + 1)

      // `--no-x` negates a declared boolean. Checked before the plain lookup so
      // a genuine flag literally named `no-cache` still wins.
      const negated =
        !byName.has(name) && name.startsWith('no-') ? byName.get(name.slice(3)) : undefined
      if (negated && negated.type === 'boolean') {
        if (inline !== undefined) {
          throw invalidNegation(token, where)
        }
        push(negated, false)
        continue
      }

      const meta = byName.get(name)
      if (!meta) {
        if (!options.allowUnknownFlags) throw unknownFlag(`--${name}`, where, declaredFlags)
        // An undeclared flag has no type to go on, so `--foo bar` is read the
        // way a shell parser does: the next token is its value unless it looks
        // like another flag. Treating it as a bare boolean would drop `bar`
        // entirely — a proxy command would silently lose its arguments.
        if (inline !== undefined) {
          unknown[name] = inline
        } else {
          const next = argv[i + 1]
          if (next !== undefined && (!next.startsWith('-') || next === '-')) {
            unknown[name] = next
            i++
          } else {
            unknown[name] = true
          }
        }
        continue
      }
      i = consume({ meta, value: inline }, argv, i, { push, mention }, where)
      continue
    }

    // -a, -a value, -abc (grouped booleans)
    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1)
      const eq = body.indexOf('=')
      const chars = eq === -1 ? body : body.slice(0, eq)
      const inline = eq === -1 ? undefined : body.slice(eq + 1)

      if (chars.length === 1) {
        const meta = byAlias.get(chars)
        if (!meta) {
          if (!options.allowUnknownFlags) throw unknownFlag(`-${chars}`, where, declaredFlags)
          if (inline !== undefined) {
            unknown[chars] = inline
          } else {
            const next = argv[i + 1]
            if (next !== undefined && (!next.startsWith('-') || next === '-')) {
              unknown[chars] = next
              i++
            } else {
              unknown[chars] = true
            }
          }
          continue
        }
        i = consume({ meta, value: inline }, argv, i, { push, mention }, where)
        continue
      }

      // A group like `-rs` can only be booleans: there is no way to attach a
      // value to more than one flag at a time.
      for (const char of chars) {
        const meta = byAlias.get(char)
        if (!meta) {
          if (!options.allowUnknownFlags) throw unknownFlag(`-${char}`, where, declaredFlags)
          unknown[char] = true
          continue
        }
        if (meta.type !== 'boolean') {
          throw new ReamError(
            'E_CONSOLE_INVALID_FLAG_GROUP',
            `Cannot group "-${char}" with other flags${where} — "--${meta.flagName}" expects a value.`,
            { hint: `Pass it on its own: -${char} <value>` },
          )
        }
        push(meta, true)
      }
      continue
    }

    positionals.push(token)
  }

  const extraArgs: string[] = []
  const strict = options.validate !== false
  const flags = applyParse(
    declaredFlags,
    materialiseFlags(declaredFlags, collected, unknown, where, strict),
  )
  const args = applyParse(
    declaredArgs,
    materialiseArgs(
      declaredArgs,
      positionals,
      where,
      options.allowUnknownFlags === true,
      extraArgs,
      strict,
    ),
  )

  // Rekeyed into Console's shape only here: defaults and `parse` are applied per
  // DECLARATION, which needs the property name, while what comes out describes
  // what was typed — positionals as a list, flags under their CLI name.
  const byFlagName: Record<string, unknown> = { ...unknown }
  for (const meta of declaredFlags) {
    if (meta.propertyName in flags) byFlagName[meta.flagName] = flags[meta.propertyName]
  }

  return {
    unknownFlags: Object.keys(unknown),
    flags: byFlagName,
    args: declaredArgs.map((meta) => args[meta.propertyName]),
    extraArgs,
    _: extraArgs,
    nodeArgs: [],
  }
}

/**
 * Run each declared input's `parse` callback over the materialised value.
 *
 * Applied last, on the already-typed value, so `parse` receives a number for a
 * number flag rather than the raw token — and only for inputs that were
 * actually provided or defaulted, never for an absent optional one.
 */
function applyParse<
  M extends { propertyName: string; parse?: (value: never) => unknown },
  V extends Record<string, unknown>,
>(declared: readonly M[], values: V): V {
  for (const meta of declared) {
    if (meta.parse === undefined) continue
    const current = values[meta.propertyName]
    if (current === undefined) continue
    Reflect.set(values, meta.propertyName, Reflect.apply(meta.parse, undefined, [current]))
  }
  return values
}

/**
 * Attach a value to a flag, pulling the next argv token when the value was not
 * written inline. Returns the new cursor position.
 */
function consume(
  raw: RawFlag,
  argv: readonly string[],
  index: number,
  collect: {
    push: (meta: FlagMetaData, value: string | boolean) => void
    mention: (meta: FlagMetaData) => void
  },
  where: string,
): number {
  const { push, mention } = collect
  const { meta, value } = raw

  if (meta.type === 'boolean') {
    if (value === undefined) {
      push(meta, true)
      return index
    }
    // `--force=false` is explicit enough to honour; anything else is a typo.
    if (value === 'true' || value === 'false') {
      push(meta, value === 'true')
      return index
    }
    throw new ReamError(
      'E_CONSOLE_INVALID_FLAG_VALUE',
      `Flag "--${meta.flagName}"${where} is a boolean and cannot take the value "${value}".`,
      { hint: `Use --${meta.flagName} or --no-${meta.flagName}` },
    )
  }

  if (value !== undefined) {
    push(meta, value)
    return index
  }

  // Value-taking flag with no inline value: the next token is it. A token that
  // itself looks like a flag is NOT consumed — `--email --name x` is a mistake
  // worth reporting, not an email of "--name".
  const next = argv[index + 1]
  if (next === undefined || (next.startsWith('-') && next !== '-')) {
    // Unless the flag says an empty value is meaningful (Console
    // `allowEmptyValue`), in which case the mention itself is the value.
    if (meta.allowEmptyValue === true) {
      // An array flag with nothing behind it is an EMPTY list, not a list
      // holding one empty string — `mention` records it without a value.
      if (meta.type === 'array') mention(meta)
      else push(meta, '')
      return index
    }
    throw new ReamError(
      'E_CONSOLE_MISSING_FLAG_VALUE',
      `Flag "--${meta.flagName}"${where} expects a value.`,
      { hint: `Example: --${meta.flagName}=<value>` },
    )
  }
  push(meta, next)
  return index + 1
}

/** Apply types, defaults and required checks to the collected flag values. */
function materialiseFlags(
  declared: readonly FlagMetaData[],
  collected: Map<string, Array<string | boolean>>,
  unknown: Record<string, string | boolean>,
  where: string,
  strict: boolean,
): Record<string, string | string[] | number | boolean> {
  const out: Record<string, string | string[] | number | boolean> = { ...unknown }

  for (const meta of declared) {
    const values = collected.get(meta.propertyName)

    if (values === undefined) {
      if (meta.default !== undefined) out[meta.propertyName] = meta.default
      else if (meta.required && strict) {
        throw new ReamError(
          'E_CONSOLE_MISSING_FLAG',
          `Missing required flag "--${meta.flagName}"${where}.`,
        )
      }
      continue
    }

    switch (meta.type) {
      case 'array':
        out[meta.propertyName] = values.map(String)
        break
      case 'number': {
        // Last one wins for scalars, matching how shells are normally used.
        const last = String(values[values.length - 1])
        const parsed = Number(last)
        if (last.trim() === '' || Number.isNaN(parsed)) {
          throw new ReamError(
            'E_CONSOLE_INVALID_FLAG_VALUE',
            `Flag "--${meta.flagName}"${where} expects a number, got "${last}".`,
          )
        }
        out[meta.propertyName] = parsed
        break
      }
      case 'boolean':
        out[meta.propertyName] = Boolean(values[values.length - 1])
        break
      default:
        out[meta.propertyName] = String(values[values.length - 1])
    }
  }

  return out
}

/** Map positionals onto declared arguments, honouring `@args.spread()`. */
function materialiseArgs(
  declared: readonly ArgumentMetaData[],
  positionals: readonly string[],
  where: string,
  allowExtra: boolean,
  extraArgs: string[],
  strict: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  let cursor = 0

  for (const meta of declared) {
    if (meta.type === 'spread') {
      const rest = positionals.slice(cursor)
      cursor = positionals.length
      if (rest.length === 0) {
        // No default and nothing to collect: the argument is UNDEFINED, not an
        // empty list (Console). A command that distinguishes "not given" from
        // "given empty" must be able to tell them apart.
        if (meta.default !== undefined) out[meta.propertyName] = meta.default
        else if (meta.required && strict) throw missingArgument(meta, where)
        continue
      }
      out[meta.propertyName] = rest
      continue
    }

    const value = positionals[cursor]
    cursor++
    if (value === undefined) {
      if (meta.default !== undefined) out[meta.propertyName] = meta.default
      else if (meta.required && strict) throw missingArgument(meta, where)
      continue
    }
    // An empty positional is nearly always a shell variable that did not
    // expand, so it is reported rather than accepted (Console) — unless the
    // argument declares that an empty value means something.
    if (value === '' && meta.allowEmptyValue !== true && strict) {
      throw new ReamError(
        'E_CONSOLE_MISSING_ARGUMENT_VALUE',
        `Missing value for argument "${meta.argumentName}"${where}.`,
      )
    }
    out[meta.propertyName] = value
  }

  // Anything left over was never asked for. Swallowing it hides a typo:
  // `greet john extra` would run as `greet john`, silently dropping the rest.
  // A `spread` argument consumes the tail, so this only fires without one.
  if (cursor < positionals.length) {
    const extra = positionals.slice(cursor)
    // A proxy command (allowUnknownFlags) keeps them — forwarding them is its
    // whole purpose. Anything else reports them, because swallowing a
    // positional hides a typo.
    if (allowExtra) {
      extraArgs.push(...extra)
      return out
    }
    throw new ReamError(
      'E_CONSOLE_UNEXPECTED_ARGUMENT',
      `Unexpected argument${extra.length > 1 ? 's' : ''} ${extra.map((value) => `"${value}"`).join(', ')}${where}.`,
      {
        hint:
          declared.length === 0
            ? 'This command takes no positional arguments.'
            : `It takes ${declared.length}: ${declared.map((arg) => arg.argumentName).join(', ')}.`,
      },
    )
  }

  return out
}

/**
 * Check a parsed input against a command's declarations (Console `validate`).
 *
 * Separate from parsing because the ORDER matters: Console runs the global-flag
 * listeners between the two, which is what lets `--help` work on a command
 * whose flags are required. One implementation, called by the kernel and by
 * `BaseCommand.validate()`.
 *
 * Positionals are accepted as a list (Console's shape) or keyed by property name
 * (what a hand-built Ream input holds).
 */
export function validateParsed(
  parsed: {
    args: readonly unknown[] | Record<string, unknown>
    flags?: Record<string, unknown>
    unknownFlags?: readonly string[]
  },
  declarations: {
    args?: readonly ArgumentMetaData[]
    flags?: readonly FlagMetaData[]
    allowUnknownFlags?: boolean
    commandName?: string
  },
): void {
  const where = declarations.commandName ? ` for "${declarations.commandName}"` : ''
  const byPosition = Array.isArray(parsed.args) ? parsed.args : undefined
  const byName: Record<string, unknown> = byPosition === undefined ? { ...parsed.args } : {}

  ;(declarations.args ?? []).forEach((arg, index) => {
    const value = byPosition === undefined ? byName[arg.propertyName] : byPosition[index]

    if (arg.required && value === undefined) throw missingArgument(arg, where)
    if (value === undefined || arg.allowEmptyValue === true) return
    if (value === '' || (Array.isArray(value) && value.length === 0)) {
      throw new ReamError(
        'E_CONSOLE_MISSING_ARGUMENT_VALUE',
        `Missing value for argument "${arg.argumentName}"${where}.`,
      )
    }
  })

  const unknown = parsed.unknownFlags ?? []
  if (declarations.allowUnknownFlags !== true && unknown.length > 0) {
    const flag = unknown[0] ?? ''
    throw new ReamError(
      'E_CONSOLE_UNKNOWN_FLAG',
      `Unknown flag "${flag.length === 1 ? `-${flag}` : `--${flag}`}"${where}.`,
    )
  }

  const flags: Record<string, unknown> = parsed.flags ?? {}
  for (const flag of declarations.flags ?? []) {
    // Keyed by flag name (Console, and what the parser returns) or by property
    // name — a hand-built input must validate whichever shape it was written in.
    const key = Object.hasOwn(flags, flag.flagName) ? flag.flagName : flag.propertyName
    const mentioned = Object.hasOwn(flags, key)
    const value = flags[key]

    if (flag.required && !mentioned) {
      throw new ReamError(
        'E_CONSOLE_MISSING_FLAG',
        `Missing required flag "--${flag.flagName}"${where}.`,
      )
    }
    if (!mentioned || flag.allowEmptyValue === true) continue

    if (flag.type === 'number') {
      if (value === undefined || Number.isNaN(value)) {
        throw new ReamError(
          'E_CONSOLE_INVALID_FLAG_VALUE',
          `Flag "--${flag.flagName}"${where} expects a number, got "${String(value)}".`,
        )
      }
      continue
    }

    // A mentioned string/array flag with nothing behind it: `--name` alone
    // yields '' from a parser, and an empty array for a repeatable flag.
    if (flag.type === 'boolean') continue
    if (value === '' || (Array.isArray(value) && value.length === 0)) {
      throw new ReamError(
        'E_CONSOLE_MISSING_FLAG_VALUE',
        `Missing value for flag "--${flag.flagName}"${where}.`,
      )
    }
  }
}

/**
 * Assign the parsed values to the properties they were declared on.
 *
 * The single hydration path: `BaseCommand.hydrate()` calls it, and so does the
 * kernel for a command declared structurally, which has no `hydrate()` of its
 * own. Both input shapes are accepted — positionals as a list (what the parser
 * now returns, and Console's shape) or keyed by property name, flags under their
 * flag name or their property name — because a hand-built input is a documented
 * use case.
 */
export function assignParsedValues(
  target: object,
  declaredArgs: readonly ArgumentMetaData[],
  declaredFlags: readonly FlagMetaData[],
  parsed: { args: unknown[] | Record<string, unknown>; flags: Record<string, unknown> },
): void {
  const byPosition = Array.isArray(parsed.args) ? parsed.args : undefined
  const byArgName: Record<string, unknown> = byPosition === undefined ? { ...parsed.args } : {}

  declaredArgs.forEach((meta, index) => {
    define(target, meta.propertyName, byPosition?.[index] ?? byArgName[meta.propertyName])
  })

  for (const meta of declaredFlags) {
    const key = Object.hasOwn(parsed.flags, meta.flagName) ? meta.flagName : meta.propertyName
    define(target, meta.propertyName, parsed.flags[key])
  }
}

/** Writable and enumerable, as Console's `hydrate` defines them. */
function define(target: object, property: string, value: unknown): void {
  Object.defineProperty(target, property, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Exported so `BaseCommand.validate()` reports a missing argument with the very
 * message the parser uses — two wordings for one rule is how they drift apart.
 */
export function missingArgument(meta: ArgumentMetaData, where = ''): ReamError {
  return new ReamError(
    'E_CONSOLE_MISSING_ARGUMENT',
    `Missing required argument "${meta.argumentName}"${where}.`,
    meta.description ? { hint: meta.description } : undefined,
  )
}

function unknownFlag(token: string, where: string, declared: readonly FlagMetaData[]): ReamError {
  const known = declared.map((f) => `--${f.flagName}`).join(', ')
  return new ReamError('E_CONSOLE_UNKNOWN_FLAG', `Unknown flag "${token}"${where}.`, {
    hint: known.length > 0 ? `Known flags: ${known}` : 'This command declares no flags.',
  })
}

function invalidNegation(token: string, where: string): ReamError {
  return new ReamError(
    'E_CONSOLE_INVALID_FLAG_VALUE',
    `"${token}"${where} negates a boolean flag and cannot carry a value.`,
  )
}

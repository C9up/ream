/**
 * `@args` / `@flags` decorators — declarative command inputs (Ace parity).
 *
 * Legacy (experimental) property decorators, matching the rest of the codebase
 * and the project's swc config (`legacyDecorator: true`). Metadata is written
 * onto the class as the static `args` / `flags` arrays the kernel reads, so a
 * command satisfies the dispatch contract without inheriting anything.
 *
 *   export default class Provision extends BaseCommand {
 *     static commandName = 'provision'
 *     static description = 'Create the owner account'
 *
 *     @flags.string({ description: 'Owner email', required: true })
 *     declare email: string
 *
 *     @flags.string({ default: 'Owner' })
 *     declare name: string
 *   }
 *
 * Properties are declared with `declare` on purpose: under `target: ES2022`
 * a real class field would be re-initialised to `undefined` at construction
 * and wipe the value the kernel assigned.
 */

import { ReamError } from '../errors/ReamError.js'
import type { ArgumentMetaData, FlagMetaData } from './types.js'

/** `startServer` → `start-server`. */
function dashCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Own-property lists per class.
 *
 * A subclass must not push into its parent's array — that would leak its flags
 * onto every sibling. When the class does not own the list yet, seed a copy of
 * whatever it inherited so extending a command keeps the parent's inputs.
 */
function ownList<T>(ctor: object, key: 'args' | 'flags'): T[] {
  if (!Object.hasOwn(ctor, key)) {
    const inherited: unknown = Reflect.get(ctor, key)
    Reflect.set(ctor, key, Array.isArray(inherited) ? [...inherited] : [])
  }
  const list: unknown = Reflect.get(ctor, key)
  return Array.isArray(list) ? list : []
}

export interface ArgumentOptions {
  /** Name shown in help. Defaults to the dash-cased property name. */
  argumentName?: string
  description?: string
  /** Defaults to `true`, as in Ace — positional arguments are expected. */
  required?: boolean
  default?: string | string[]
  /** Accept an empty value instead of reporting it (Ace `allowEmptyValue`). */
  allowEmptyValue?: boolean
  /** Transform or validate the value before assignment (Ace `parse`). */
  parse?: (value: string | string[]) => unknown
}

export interface FlagOptions {
  /** Name used on the command line. Defaults to the dash-cased property name. */
  flagName?: string
  description?: string
  /** Single-character shorthands, e.g. `['r']` for `-r`. */
  alias?: string | string[]
  default?: string | string[] | number | boolean
  /** Defaults to `false` — a flag is optional unless stated otherwise. */
  required?: boolean
  /** Accept `--flag` with no value behind it (Ace `allowEmptyValue`). */
  allowEmptyValue?: boolean
  /** Transform or validate the value before assignment (Ace `parse`). */
  parse?: (value: string | string[] | number | boolean) => unknown
  /**
   * Show `--no-<flag>` next to the flag in help. Booleans are always negatable;
   * this only decides whether help says so.
   */
  showNegatedVariantInHelp?: boolean
}

/**
 * Reject an argument order the command line could never satisfy (Ace).
 *
 * Exported because `BaseCommand.defineArgument()` declares arguments through a
 * different path: one rule, or a decorated command would accept what the same
 * declaration written by hand refuses.
 */
export function assertArgumentOrder(
  declared: readonly ArgumentMetaData[],
  incoming: Pick<ArgumentMetaData, 'argumentName' | 'required'>,
): void {
  const last = declared[declared.length - 1]
  if (last === undefined) return

  if (last.type === 'spread') {
    throw new ReamError(
      'E_CONSOLE_INVALID_ARGUMENT',
      `Argument "${incoming.argumentName}" comes after the spread argument "${last.argumentName}".`,
      { hint: 'A spread argument consumes the rest, so it must be declared last.' },
    )
  }
  if (incoming.required && last.required === false) {
    throw new ReamError(
      'E_CONSOLE_INVALID_ARGUMENT',
      `Required argument "${incoming.argumentName}" comes after the optional "${last.argumentName}".`,
      { hint: 'Declare the required arguments first, or make this one optional.' },
    )
  }
}

/**
 * Build one argument's metadata from what was declared.
 *
 * The single builder for both declaration paths — the decorators and
 * `BaseCommand.defineArgument()`. Two field-by-field copies is how a new option
 * ends up honoured on one path and silently dropped on the other, which is
 * exactly what happened to `allowEmptyValue`.
 */
export function buildArgument(
  name: string,
  options: Partial<ArgumentMetaData> = {},
): ArgumentMetaData {
  return {
    type: options.type ?? 'string',
    propertyName: options.propertyName ?? name,
    argumentName: options.argumentName ?? dashCase(name),
    description: options.description,
    // An argument with a default is optional by definition.
    required: options.required ?? options.default === undefined,
    default: options.default,
    allowEmptyValue: options.allowEmptyValue,
    parse: options.parse,
  }
}

/** The same, for a flag. */
export function buildFlag(name: string, options: Partial<FlagMetaData> = {}): FlagMetaData {
  return {
    type: options.type ?? 'boolean',
    propertyName: options.propertyName ?? name,
    flagName: options.flagName ?? dashCase(name),
    description: options.description,
    alias: options.alias ?? [],
    required: options.required ?? false,
    default: options.default,
    allowEmptyValue: options.allowEmptyValue,
    parse: options.parse,
    showNegatedVariantInHelp: options.showNegatedVariantInHelp,
  }
}

function defineArgument(type: ArgumentMetaData['type'], options: ArgumentOptions) {
  return (target: object, propertyKey: string | symbol): void => {
    const argument = buildArgument(String(propertyKey), { ...options, type })
    const list = ownList<ArgumentMetaData>(target.constructor, 'args')
    assertArgumentOrder(list, argument)
    list.push(argument)
  }
}

function defineFlag(type: FlagMetaData['type'], options: FlagOptions) {
  return (target: object, propertyKey: string | symbol): void => {
    // `alias` is a string or a list at the decorator, always a list in the
    // metadata — the only shape the builder cannot normalise for both paths.
    const alias = options.alias === undefined ? [] : [options.alias].flat()
    const list = ownList<FlagMetaData>(target.constructor, 'flags')
    list.push(buildFlag(String(propertyKey), { ...options, type, alias }))
  }
}

/** Positional arguments. Declaration order is the command-line order. */
export const args = {
  /** A single positional value. */
  string(options: ArgumentOptions = {}) {
    return defineArgument('string', options)
  },
  /** Collects every remaining positional into an array. Declare it last. */
  spread(options: ArgumentOptions = {}) {
    return defineArgument('spread', options)
  },
}

/** Named flags. */
export const flags = {
  string(options: FlagOptions = {}) {
    return defineFlag('string', options)
  },
  boolean(options: FlagOptions = {}) {
    return defineFlag('boolean', options)
  },
  number(options: FlagOptions = {}) {
    return defineFlag('number', options)
  },
  /** Repeatable flag: `--tag a --tag b` → `['a', 'b']`. */
  array(options: FlagOptions = {}) {
    return defineFlag('array', options)
  },
}

/**
 * Env validation schema — mirrors `@adonisjs/core/env`'s `Env.schema` surface:
 *
 *   Env.schema.string({ format: 'host' })
 *   Env.schema.number()
 *   Env.schema.boolean()
 *   Env.schema.enum(['development', 'production', 'test'] as const)
 *   Env.schema.string.optional()       // shortcut form
 *   Env.schema.enum([...]).optional()  // node form
 *
 * Each node validates + coerces a raw `process.env` string into its typed
 * value (or throws {@link EnvVarError}); `.optional()` accepts an absent/empty
 * value as `undefined`.
 */

import { Secret } from './Secret.js'

/** A single failed-variable validation — collected by `Env.create`. */
export class EnvVarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvVarError'
  }
}

/** A validator: parse + coerce a raw env value (or `undefined`) into `T`. */
export interface SchemaNode<T> {
  validate(name: string, value: string | undefined): T
}

/** Condition deciding whether a variable is optional (AdonisJS `optionalWhen`). */
export type OptionalCondition = boolean | ((name: string, value: string | undefined) => boolean)

/**
 * A required node that can be turned optional — `.optional()` widens `T` to
 * `T | undefined`; `.optionalWhen(cond)` does so only when `cond` holds.
 */
export interface RequiredNode<T> extends SchemaNode<T> {
  optional(): SchemaNode<T | undefined>
  optionalWhen(condition: OptionalCondition): SchemaNode<T | undefined>
}

/** Options common to every schema function (AdonisJS `SchemaFnOptions`). */
export interface SchemaFnOptions {
  /** Custom error message, replacing the default when validation fails. */
  message?: string
}

export interface StringOptions extends SchemaFnOptions {
  /** Validate the string against a known format. */
  format?: 'host' | 'url' | 'email' | 'uuid'
  /** For `format: 'url'` — require a TLD (default true). */
  tld?: boolean
  /** For `format: 'url'` — require a protocol (default true). */
  protocol?: boolean
}

const TRUE_VALUES = new Set(['true', '1'])
const FALSE_VALUES = new Set(['false', '0'])

/**
 * Build a node from a `parse` that only ever sees a present, non-empty string.
 * Required `validate` throws on absent/empty (using `message` when given);
 * `.optional()` returns `undefined`; `.optionalWhen(cond)` is optional only
 * when the condition holds.
 */
function makeNode<T>(parse: (name: string, raw: string) => T, message?: string): RequiredNode<T> {
  const required = (name: string, value: string | undefined): T => {
    if (value === undefined || value === '') {
      throw new EnvVarError(message ?? `Missing required environment variable "${name}"`)
    }
    return parse(name, value)
  }
  const optional = (name: string, value: string | undefined): T | undefined => {
    if (value === undefined || value === '') return undefined
    return parse(name, value)
  }
  return {
    validate: required,
    optional: () => ({ validate: optional }),
    optionalWhen: (condition) => ({
      validate(name, value) {
        const skip = typeof condition === 'function' ? condition(name, value) : condition
        return skip ? optional(name, value) : required(name, value)
      },
    }),
  }
}

function isHost(value: string): boolean {
  if (value === 'localhost') return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255)
  }
  if (value.includes(':') && /^[0-9a-fA-F:]+$/.test(value)) return true // loose IPv6
  return /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/.test(value)
}

function isUrl(value: string, options: StringOptions): boolean {
  const candidate = options.protocol === false && !value.includes('://') ? `http://${value}` : value
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (options.tld !== false && !url.hostname.includes('.') && url.hostname !== 'localhost') {
    return false
  }
  return true
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function checkFormat(name: string, value: string, options?: StringOptions): void {
  if (!options?.format) return
  const ok =
    options.format === 'host'
      ? isHost(value)
      : options.format === 'url'
        ? isUrl(value, options)
        : options.format === 'uuid'
          ? isUuid(value)
          : isEmail(value)
  if (!ok) {
    throw new EnvVarError(
      options.message ??
        `Environment variable "${name}" must be a valid ${options.format}, got "${value}"`,
    )
  }
}

function stringParse(options?: StringOptions): (name: string, raw: string) => string {
  return (name, raw) => {
    checkFormat(name, raw, options)
    return raw
  }
}

/**
 * `string(opts?)` is callable AND exposes `.optional(opts?)` / `.optionalWhen()`
 * shortcuts — all AdonisJS forms.
 */
const string: ((options?: StringOptions) => RequiredNode<string>) & {
  optional(options?: StringOptions): SchemaNode<string | undefined>
  optionalWhen(
    condition: OptionalCondition,
    options?: StringOptions,
  ): SchemaNode<string | undefined>
} = Object.assign((options?: StringOptions) => makeNode(stringParse(options), options?.message), {
  optional: (options?: StringOptions) =>
    makeNode(stringParse(options), options?.message).optional(),
  optionalWhen: (condition: OptionalCondition, options?: StringOptions) =>
    makeNode(stringParse(options), options?.message).optionalWhen(condition),
})

function numberParse(options?: SchemaFnOptions): (name: string, raw: string) => number {
  return (name, raw) => {
    const parsed = Number(raw)
    if (Number.isNaN(parsed)) {
      throw new EnvVarError(
        options?.message ?? `Environment variable "${name}" must be a number, got "${raw}"`,
      )
    }
    return parsed
  }
}

function number(options?: SchemaFnOptions): RequiredNode<number> {
  return makeNode(numberParse(options), options?.message)
}

function booleanParse(options?: SchemaFnOptions): (name: string, raw: string) => boolean {
  return (name, raw) => {
    if (TRUE_VALUES.has(raw)) return true
    if (FALSE_VALUES.has(raw)) return false
    throw new EnvVarError(
      options?.message ??
        `Environment variable "${name}" must be a boolean (true/false/1/0), got "${raw}"`,
    )
  }
}

function boolean(options?: SchemaFnOptions): RequiredNode<boolean> {
  return makeNode(booleanParse(options), options?.message)
}

function enumNode<V extends readonly string[]>(
  values: V,
  options?: SchemaFnOptions,
): RequiredNode<V[number]> {
  return makeNode((name, raw) => {
    const match = values.find((candidate) => candidate === raw)
    if (match === undefined) {
      throw new EnvVarError(
        options?.message ??
          `Environment variable "${name}" must be one of [${values.join(', ')}], got "${raw}"`,
      )
    }
    return match
  }, options?.message)
}

/**
 * `secret(opts?)` wraps the value in a {@link Secret} so it never leaks through
 * logs/JSON (AdonisJS `Env.schema.secret`). Read it with `.release()`.
 */
const secret: ((options?: SchemaFnOptions) => RequiredNode<Secret<string>>) & {
  optional(options?: SchemaFnOptions): SchemaNode<Secret<string> | undefined>
  optionalWhen(
    condition: OptionalCondition,
    options?: SchemaFnOptions,
  ): SchemaNode<Secret<string> | undefined>
} = Object.assign(
  (options?: SchemaFnOptions) => makeNode((_name, raw) => new Secret(raw), options?.message),
  {
    optional: (options?: SchemaFnOptions) =>
      makeNode((_name, raw) => new Secret(raw), options?.message).optional(),
    optionalWhen: (condition: OptionalCondition, options?: SchemaFnOptions) =>
      makeNode((_name, raw) => new Secret(raw), options?.message).optionalWhen(condition),
  },
)

/** The `Env.schema` surface. */
export const schema = {
  string,
  number,
  boolean,
  enum: enumNode,
  secret,
}

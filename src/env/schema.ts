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

/** A required node that can be turned optional — `.optional()` widens `T` to `T | undefined`. */
export interface RequiredNode<T> extends SchemaNode<T> {
  optional(): SchemaNode<T | undefined>
}

export interface StringOptions {
  /** Validate the string against a known format. */
  format?: 'host' | 'url' | 'email'
  /** For `format: 'url'` — require a TLD (default true). */
  tld?: boolean
  /** For `format: 'url'` — require a protocol (default true). */
  protocol?: boolean
}

const TRUE_VALUES = new Set(['true', '1'])
const FALSE_VALUES = new Set(['false', '0'])

/**
 * Build a node from a `parse` that only ever sees a present, non-empty string.
 * Required `validate` throws on absent/empty; `.optional()` returns `undefined`.
 */
function makeNode<T>(parse: (name: string, raw: string) => T): RequiredNode<T> {
  return {
    validate(name, value) {
      if (value === undefined || value === '') {
        throw new EnvVarError(`Missing required environment variable "${name}"`)
      }
      return parse(name, value)
    },
    optional() {
      return {
        validate(name, value) {
          if (value === undefined || value === '') return undefined
          return parse(name, value)
        },
      }
    },
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

function checkFormat(name: string, value: string, options?: StringOptions): void {
  if (!options?.format) return
  const ok =
    options.format === 'host'
      ? isHost(value)
      : options.format === 'url'
        ? isUrl(value, options)
        : isEmail(value)
  if (!ok) {
    throw new EnvVarError(
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

/** `string(opts?)` is callable AND exposes `.optional(opts?)` — both Adonis forms. */
const string: ((options?: StringOptions) => RequiredNode<string>) & {
  optional(options?: StringOptions): SchemaNode<string | undefined>
} = Object.assign((options?: StringOptions) => makeNode(stringParse(options)), {
  optional: (options?: StringOptions) => makeNode(stringParse(options)).optional(),
})

function number(): RequiredNode<number> {
  return makeNode((name, raw) => {
    const parsed = Number(raw)
    if (Number.isNaN(parsed)) {
      throw new EnvVarError(`Environment variable "${name}" must be a number, got "${raw}"`)
    }
    return parsed
  })
}

function boolean(): RequiredNode<boolean> {
  return makeNode((name, raw) => {
    if (TRUE_VALUES.has(raw)) return true
    if (FALSE_VALUES.has(raw)) return false
    throw new EnvVarError(
      `Environment variable "${name}" must be a boolean (true/false/1/0), got "${raw}"`,
    )
  })
}

function enumNode<V extends readonly string[]>(values: V): RequiredNode<V[number]> {
  return makeNode((name, raw) => {
    const match = values.find((candidate) => candidate === raw)
    if (match === undefined) {
      throw new EnvVarError(
        `Environment variable "${name}" must be one of [${values.join(', ')}], got "${raw}"`,
      )
    }
    return match
  })
}

/** The `Env.schema` surface. */
export const schema = {
  string,
  number,
  boolean,
  enum: enumNode,
}

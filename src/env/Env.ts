import { loadEnvFiles } from './loadEnvFiles.js'
import { type SchemaNode, schema } from './schema.js'

/**
 * Type-safe environment access — mirrors `@adonisjs/core/env`:
 *
 *   // start/env.ts
 *   import { Env } from '@c9up/ream'
 *   export default await Env.create(new URL('../', import.meta.url), {
 *     HOST: Env.schema.string({ format: 'host' }),
 *     PORT: Env.schema.number(),
 *     NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
 *     DATABASE_URL: Env.schema.string.optional(),
 *   })
 *
 *   // config/database.ts
 *   import env from '#start/env'
 *   const port = env.get('PORT')   // typed `number`
 *
 * `create` loads the `.env*` files (so config read at import sees them, in EVERY
 * flow incl. tests), validates each variable against the schema, and refuses to
 * start with a descriptive error if a required variable is missing or invalid.
 */

/** The validated output type of a single schema node. */
type EnvOutput<N> = N extends SchemaNode<infer T> ? T : never

/** Map a schema object to its `{ key: validatedType }` record. */
type EnvRecord<S extends Record<string, SchemaNode<unknown>>> = {
  [K in keyof S]: EnvOutput<S[K]>
}

/** Raised when one or more environment variables fail validation. */
export class EnvValidationException extends Error {
  /** Human-readable, newline-joined list of every failure (cf. Adonis `error.help`). */
  readonly help: string
  constructor(failures: string[]) {
    super('Environment variables validation failed')
    this.name = 'E_INVALID_ENV_VARIABLES'
    this.help = failures.join('\n')
  }
}

export class Env<Values extends Record<string, unknown>> {
  /** The validation schema surface — `Env.schema.string()`, `.number()`, … */
  static readonly schema = schema

  readonly #values: Values

  private constructor(values: Values) {
    this.#values = values
  }

  /**
   * Load `.env*` files, validate `process.env` against `schema`, and return a
   * typed `Env`. Throws {@link EnvValidationException} (aggregating every
   * failure) if validation fails.
   */
  static async create<S extends Record<string, SchemaNode<unknown>>>(
    appRoot: URL,
    schema: S,
  ): Promise<Env<EnvRecord<S>>> {
    loadEnvFiles(appRoot, { skipEnvLocal: process.env.NODE_ENV === 'test' })

    const failures: string[] = []
    const collected: Record<string, unknown> = {}
    for (const key of Object.keys(schema)) {
      try {
        collected[key] = schema[key].validate(key, process.env[key])
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err))
      }
    }
    if (failures.length > 0) throw new EnvValidationException(failures)

    // The ONE isolated type-erasure boundary (the same place zod / @adonisjs/env
    // cast internally): every entry of `collected` was produced by its schema
    // node's validator, so the object structurally IS `EnvRecord<S>` — TS just
    // can't carry that proof through the dynamic `Object.keys` loop. Load-bearing.
    return new Env(collected as EnvRecord<S>)
  }

  /** Read a validated variable. Required keys are always present; optional keys may be `undefined`. */
  get<K extends keyof Values>(key: K): Values[K]
  get<K extends keyof Values>(key: K, fallback: Values[K]): Values[K]
  get<K extends keyof Values>(key: K, fallback?: Values[K]): Values[K] {
    const value = this.#values[key]
    if (value === undefined && fallback !== undefined) return fallback
    return value
  }
}

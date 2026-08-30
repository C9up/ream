import {
  defineIdentifier,
  defineIdentifierIfMissing,
  type IdentifierResolver,
  removeIdentifier,
} from './interpolate.js'
import { loadEnvFiles } from './loadEnvFiles.js'
import { normalizeNodeEnv } from './nodeEnv.js'
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

  /** Register an interpolation identifier (AdonisJS `Env.defineIdentifier`). */
  static defineIdentifier(name: string, resolver: IdentifierResolver): void {
    defineIdentifier(name, resolver)
  }

  /** Register an identifier only if the name is free (AdonisJS `defineIdentifierIfMissing`). */
  static defineIdentifierIfMissing(name: string, resolver: IdentifierResolver): void {
    defineIdentifierIfMissing(name, resolver)
  }

  /** Remove a registered interpolation identifier (AdonisJS `Env.removeIdentifier`). */
  static removeIdentifier(name: string): void {
    removeIdentifier(name)
  }

  readonly #values: Values

  /**
   * Private on purpose: an `Env` is only ever built by {@link create}, which is
   * what validates. `private` and not `#` because a private CONSTRUCTOR has no
   * native form — this is the one place the keyword carries a meaning `#`
   * cannot express.
   */
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
    loadEnvFiles(appRoot, { skipEnvLocal: normalizeNodeEnv(process.env.NODE_ENV) === 'test' })

    return new Env(Env.rules(schema).validate(process.env))
  }

  /**
   * Turn a schema into a reusable validator (AdonisJS `Env.rules`).
   *
   * `create` reads `process.env`; this validates any record — a parsed `.env`
   * file, a fixture, a subset a test wants to check — and aggregates every
   * failure into one {@link EnvValidationException} rather than stopping at
   * the first.
   */
  static rules<S extends Record<string, SchemaNode<unknown>>>(
    schema: S,
  ): { validate(values: Record<string, string | undefined>): EnvRecord<S> } {
    return {
      validate(values: Record<string, string | undefined>): EnvRecord<S> {
        const failures: string[] = []
        const collected: Record<string, unknown> = {}
        for (const key of Object.keys(schema)) {
          try {
            collected[key] = schema[key].validate(key, values[key])
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err))
          }
        }
        if (failures.length > 0) throw new EnvValidationException(failures)

        // The ONE isolated type-erasure boundary (the same place zod /
        // @adonisjs/env cast internally): every entry of `collected` was
        // produced by its schema node's validator, so the object structurally
        // IS `EnvRecord<S>` — TS just can't carry that proof through the
        // dynamic `Object.keys` loop. Load-bearing.
        return collected as EnvRecord<S>
      },
    }
  }

  /**
   * Read a variable. Validated keys are typed; for any other key the raw
   * `process.env` value is returned as a fallback (AdonisJS `env.get`
   * semantics). Required keys are always present; optional keys may be
   * `undefined`. The second argument is the default when nothing is found.
   */
  get<K extends keyof Values>(key: K): Values[K]
  get<K extends keyof Values>(key: K, fallback: Values[K]): Values[K]
  get(key: string): string | undefined
  get(key: string, fallback: string): string
  get(key: string, fallback?: unknown): unknown {
    const cached = this.#values[key]
    if (cached !== undefined) return cached
    // Fallback to raw process.env for keys outside the validated schema.
    const fromEnv = process.env[key]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return fallback
  }

  /**
   * Set/override a variable at runtime (AdonisJS `env.set`). Updates the cache
   * AND `process.env`. The value is NOT re-validated — pass the correct type.
   */
  set<K extends keyof Values>(key: K, value: Values[K]): void
  set(key: string, value: string): void
  set(key: string, value: unknown): void {
    // Reflect.set writes to the generic-typed cache without a cast (a direct
    // `this.#values[key] = value` is rejected: a generic type is read-only-indexed).
    Reflect.set(this.#values, key, value)
    process.env[key] = String(value)
  }
}

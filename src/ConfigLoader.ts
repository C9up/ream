/**
 * Configuration loader — reads config/*.ts + .env files.
 *
 * @implements FR18, FR19
 */

import { getPath, hasPath, mergeDeep, setPath } from './utils/objectPath.js'

/**
 * In-memory config store. In production this is populated from config/*.ts
 * files via `defineConfig()` — one top-level key per module (`config/app.ts`
 * → `app`). The class is its own contract — `AppContext.config` is typed
 * against it directly (structural).
 *
 * Values are held as a nested tree and read with AdonisJS dot-notation
 * (`config.get('database.mysql.host')`), matching `@adonisjs/config`'s
 * `lodash`-backed accessors — reimplemented dependency-free via
 * {@link ../utils/objectPath}.
 */
export class ConfigStore {
  #tree: Record<string, unknown> = {}

  /**
   * Read a value by dot-notation key, returning `defaultValue` when the path
   * is absent or resolves to `undefined` (AdonisJS `config.get`).
   */
  get<T = unknown>(key: string): T | undefined
  get<T = unknown>(key: string, defaultValue: T): T
  get<T = unknown>(key: string, defaultValue?: T): T | undefined
  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    // Untyped store: the caller declares the shape it configured (same
    // contract as `@adonisjs/config`, whose `get<T>` returns the loose value).
    return getPath(this.#tree, key, defaultValue) as T | undefined
  }

  /** Set a value by dot-notation key, creating intermediate objects. */
  set(key: string, value: unknown): void {
    setPath(this.#tree, key, value)
  }

  /** True when the dot-notation key exists (AdonisJS `config.has`). */
  has(key: string): boolean {
    return hasPath(this.#tree, key)
  }

  /** The full config tree (AdonisJS `config.all`). */
  all(): Record<string, unknown> {
    return this.#tree
  }

  /**
   * Merge `value` as defaults for `key` — existing config wins over the
   * provided defaults (AdonisJS `config.defaults`).
   */
  defaults(key: string, value: unknown): void {
    const existing = this.get(key)
    this.set(key, existing === undefined ? value : mergeDeep(value, existing))
  }

  /**
   * Load config from an object (used for testing and initial setup). Each key
   * is applied by dot-notation, so both nested modules (`{ app: {...} }`) and
   * flat dotted keys (`{ 'db.host': '...' }`) land in the tree.
   */
  loadFromObject(config: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(config)) {
      this.set(key, value)
    }
  }
}

/**
 * Read an environment variable with optional default.
 * @implements FR19
 */
export function env(key: string): string | undefined
export function env(key: string, defaultValue: string): string
export function env(key: string, defaultValue?: string): string | undefined
export function env(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue
}

/**
 * Define typed configuration for a module.
 * Returns the config object as-is (type-checked by the module's defineConfig).
 */
export function defineModuleConfig<T>(config: T): T {
  return config
}

const CONFIG_PROVIDER = Symbol('ream.configProvider')

/** A deferred config value that resolves against the application at boot. */
interface ConfigProviderMarker<T> {
  readonly [CONFIG_PROVIDER]: (app: unknown) => T | Promise<T>
}

function isConfigProvider(value: unknown): value is ConfigProviderMarker<unknown> {
  return typeof value === 'object' && value !== null && CONFIG_PROVIDER in value
}

/**
 * Deferred configuration (AdonisJS `configProvider`). A package exports
 * `configProvider.create((app) => ...)` when its config needs the application
 * (env, paths) at boot; the framework calls `configProvider.resolve(app, value)`
 * to materialise it, passing plain values through untouched.
 */
export const configProvider = {
  /** Wrap a resolver so it's materialised later by {@link resolve}. */
  create<T>(resolver: (app: unknown) => T | Promise<T>): ConfigProviderMarker<T> {
    return { [CONFIG_PROVIDER]: resolver }
  },

  /** Resolve a value: run it if it's a provider, otherwise return it as-is. */
  async resolve<T>(app: unknown, value: ConfigProviderMarker<T> | T): Promise<T> {
    return isConfigProvider(value) ? value[CONFIG_PROVIDER](app) : value
  },
}

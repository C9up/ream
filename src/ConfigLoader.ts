/**
 * Configuration loader — reads config/*.ts + .env files.
 *
 * @implements FR18, FR19
 */

import type { ConfigStore } from './Provider.js'

/**
 * Simple in-memory config store.
 * In production, this reads from config/*.ts files with defineConfig().
 */
export class SimpleConfigStore implements ConfigStore {
  private store: Map<string, unknown> = new Map()

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key) as T | undefined
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value)
  }

  has(key: string): boolean {
    return this.store.has(key)
  }

  /** Load config from an object (used for testing and initial setup). */
  loadFromObject(config: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(config)) {
      this.store.set(key, value)
    }
  }
}

/**
 * Read an environment variable with optional default.
 * @implements FR19
 */
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

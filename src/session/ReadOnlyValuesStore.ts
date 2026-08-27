/**
 * A read-only bag of values addressed by key or key PATH, shared with templates.
 *
 * This is the shape AdonisJS shares as `session` and `flashMessages`, and the
 * shape its `@error` / `@errors` / `@inputError` tags read — `has(['errorsBag',
 * field])` and `get('inputErrorsBag', {})`. A migrated template relies on it, so
 * the path semantics have to match: a dotted string and an array address the
 * same nested value.
 */

/** A key, a dotted key path, or the same path already split. */
export type ValuePath = string | readonly string[]

function segments(path: ValuePath): string[] {
  return Array.isArray(path) ? [...path] : String(path).split('.')
}

export class ReadOnlyValuesStore {
  readonly #values: Record<string, unknown>

  constructor(values: Record<string, unknown> | null) {
    this.#values = values ?? {}
  }

  /** True when the bag holds nothing — `@if(flashMessages.isEmpty)`. */
  get isEmpty(): boolean {
    return Object.keys(this.#values).length === 0
  }

  /** Every value, as a shallow copy so a template cannot mutate the store. */
  all(): Record<string, unknown> {
    return { ...this.#values }
  }

  /** The value at `path`, or `defaultValue` when any segment is missing. */
  get(path: ValuePath, defaultValue?: unknown): unknown {
    let current: unknown = this.#values
    for (const key of segments(path)) {
      if (current === null || typeof current !== 'object') return defaultValue
      // `Reflect.get` rather than indexing: a flashed key named `__proto__`
      // must read an OWN property, never walk the prototype chain.
      if (!Object.hasOwn(current, key)) return defaultValue
      current = Reflect.get(current, key)
    }
    return current === undefined ? defaultValue : current
  }

  /** Whether `path` resolves to something other than `undefined`. */
  has(path: ValuePath): boolean {
    return this.get(path) !== undefined
  }

  /**
   * Every value, as a plain object (AdonisJS `toObject`).
   *
   * Same content as {@link all}; the two names exist because AdonisJS ships
   * both and a migrated template may reach for either.
   */
  toObject(): Record<string, unknown> {
    return this.all()
  }

  /** Every value — what `JSON.stringify(flashMessages)` emits. */
  toJSON(): Record<string, unknown> {
    return this.all()
  }

  /** JSON text, so `{{ flashMessages }}` in a template renders the contents. */
  toString(): string {
    return JSON.stringify(this.#values)
  }
}

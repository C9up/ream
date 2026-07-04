/**
 * Secret — wraps a sensitive value so it never leaks through logs, JSON, or
 * `util.inspect`. Mirrors `@poppinss/utils`'s `Secret` (zero-dep here). Read the
 * underlying value explicitly with {@link release}.
 *
 *   const key = env.get('APP_KEY')   // Secret<string> when declared via schema.secret
 *   key.toString()   // '[redacted]'
 *   JSON.stringify({ key })          // '{"key":"[redacted]"}'
 *   key.release()    // the real value — only when you deliberately need it
 */
const REDACTED = '[redacted]'

export class Secret<T> {
  readonly #value: T
  readonly #keyword: string

  constructor(value: T, redactedKeyword: string = REDACTED) {
    this.#value = value
    this.#keyword = redactedKeyword
  }

  /** Redacted placeholder (so `JSON.stringify` never emits the secret). */
  toJSON(): string {
    return this.#keyword
  }

  /** Redacted placeholder for string coercion + template literals. */
  toString(): string {
    return this.#keyword
  }

  /** Redacted placeholder for `console.log` / `util.inspect`. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.#keyword
  }

  /** Release the underlying value — the one deliberate way to read the secret. */
  release(): T {
    return this.#value
  }
}

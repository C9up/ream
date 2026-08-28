/**
 * Returns true if value is a string.
 * @example isString('hi') // true
 */
export function isString(v: unknown): v is string {
  return typeof v === 'string'
}

/**
 * Returns true if value is a finite number (excludes NaN).
 * @example isNumber(42) // true; isNumber(NaN) // false
 */
export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v)
}

/**
 * Returns true if value is a boolean.
 * @example isBoolean(true) // true
 */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

/**
 * Returns true if value is a callable function.
 * @example isFunction(() => {}) // true
 */
export function isFunction(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === 'function'
}

/**
 * Returns true if value is a non-null object.
 * @example isObject({}) // true; isObject(null) // false
 */
export function isObject(v: unknown): v is object {
  return v !== null && typeof v === 'object'
}

/**
 * Returns true if value is a plain object (non-null, non-array, prototype is Object or null).
 * @example isPlainObject({ a: 1 }) // true; isPlainObject([]) // false
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === null || proto === Object.prototype
}

/**
 * Returns true if value is an array.
 * @example isArray([1, 2]) // true
 */
export function isArray<T = unknown>(v: unknown): v is T[] {
  return Array.isArray(v)
}

/**
 * Returns true if value has a thenable interface (is a Promise or promise-like).
 * @example isPromise(Promise.resolve()) // true
 */
export function isPromise<T = unknown>(v: unknown): v is Promise<T> {
  return v !== null && typeof v === 'object' && 'then' in v && typeof v.then === 'function'
}

/**
 * Returns true if value is null.
 * @example isNull(null) // true
 */
export function isNull(v: unknown): v is null {
  return v === null
}

/**
 * Returns true if value is undefined.
 * @example isUndefined(undefined) // true
 */
export function isUndefined(v: unknown): v is undefined {
  return v === undefined
}

/**
 * Returns true if value is null or undefined.
 * @example isNullOrUndefined(null) // true; isNullOrUndefined(undefined) // true
 */
export function isNullOrUndefined(v: unknown): v is null | undefined {
  return v === null || v === undefined
}

/**
 * Returns true if value is a Node.js Buffer.
 * @example isBuffer(Buffer.from('hi')) // true
 */
export function isBuffer(v: unknown): v is Buffer {
  return Buffer.isBuffer(v)
}

/**
 * Returns true if value is a Date object.
 * @example isDate(new Date()) // true
 */
export function isDate(v: unknown): v is Date {
  return v instanceof Date
}

/**
 * Returns true if value is a RegExp.
 * @example isRegExp(/foo/) // true
 */
export function isRegExp(v: unknown): v is RegExp {
  return v instanceof RegExp
}

/**
 * Returns true if value is an Error instance.
 * @example isError(new Error()) // true
 */
export function isError(v: unknown): v is Error {
  return v instanceof Error
}

/**
 * Returns true for null, undefined, empty string, empty array, empty plain object,
 * empty Map, or empty Set.
 * @example isEmpty('') // true; isEmpty([]) // true; isEmpty({}) // true
 */
export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.length === 0
  if (Array.isArray(v)) return v.length === 0
  if (v instanceof Map || v instanceof Set) return v.size === 0
  if (isPlainObject(v)) return Object.keys(v).length === 0
  return false
}

/**
 * Returns true if value is a string with at least one character.
 * @example isNonEmptyString('hi') // true; isNonEmptyString('') // false
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Returns true if value is an array with at least one element.
 * @example isNonEmptyArray([1]) // true; isNonEmptyArray([]) // false
 */
export function isNonEmptyArray<T = unknown>(v: unknown): v is [T, ...T[]] {
  return Array.isArray(v) && v.length > 0
}

/**
 * Returns true if value is an integer. `Number.isInteger` already excludes NaN
 * and the infinities.
 * @example isInteger(42) // true; isInteger(4.2) // false
 */
export function isInteger(v: unknown): v is number {
  return Number.isInteger(v)
}

/**
 * Returns true if value is a number greater than zero. Zero is NOT positive
 * here, matching `@sindresorhus/is`.
 * @example isPositive(1) // true; isPositive(0) // false
 */
export function isPositive(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v) && v > 0
}

/**
 * Returns true if `key` is an OWN property of `value`.
 *
 * Own, not inherited: an inherited `toString` is not something the caller put
 * there, and treating it as present is how a prototype member gets mistaken
 * for data.
 * @example hasProperty({ a: 1 }, 'a') // true; hasProperty({}, 'toString') // false
 */
export function hasProperty<K extends PropertyKey>(
  value: unknown,
  key: K,
): value is Record<K, unknown> {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key)
}

/**
 * The `is` namespace, keyed the way AdonisJS keys it.
 *
 * Adonis re-exports `@sindresorhus/is`, whose members read `is.string(v)`,
 * `is.plainObject(v)`, `is.nonEmptyArray(v)`. This object used to mirror the
 * function names instead — `is.isString(v)` — which stutters, and which turns
 * `is.string(value)` ported from an Adonis app into "is.string is not a
 * function" at runtime rather than a compile error.
 *
 * The standalone `isX` functions above keep their names: they read correctly
 * on their own, and this object is the namespace form.
 */
const is = {
  string: isString,
  number: isNumber,
  boolean: isBoolean,
  function: isFunction,
  object: isObject,
  plainObject: isPlainObject,
  array: isArray,
  promise: isPromise,
  null: isNull,
  undefined: isUndefined,
  nullOrUndefined: isNullOrUndefined,
  buffer: isBuffer,
  date: isDate,
  regExp: isRegExp,
  error: isError,
  nonEmptyString: isNonEmptyString,
  nonEmptyArray: isNonEmptyArray,
  integer: isInteger,
  positive: isPositive,
  hasProperty: hasProperty,
  /**
   * Named deviation: `@sindresorhus/is` has `emptyString` / `emptyArray` /
   * `emptyObject` / `emptyMap` / `emptySet` but no umbrella. This is the
   * umbrella, and the one member here that is not a type guard.
   */
  empty: isEmpty,
}

export default is

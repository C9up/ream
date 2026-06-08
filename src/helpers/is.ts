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
  return (
    v !== null &&
    typeof v === 'object' &&
    'then' in v &&
    typeof (v as Record<string, unknown>).then === 'function'
  )
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

const is = {
  isString,
  isNumber,
  isBoolean,
  isFunction,
  isObject,
  isPlainObject,
  isArray,
  isPromise,
  isNull,
  isUndefined,
  isNullOrUndefined,
  isBuffer,
  isDate,
  isRegExp,
  isError,
  isEmpty,
}

export default is

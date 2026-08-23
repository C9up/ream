/**
 * TypeScript type helpers — utility types for the Ream framework.
 * Pattern aligned with @adonisjs/core/helpers/types.
 */

// ─── Already present (kept for backward compat) ───────────

/** Infer route parameters from a route pattern string. */
export type InferRouteParams<T extends string> = T extends `${string}:${infer Param}/${infer Rest}`
  ? { [K in Param | keyof InferRouteParams<`/${Rest}`>]: string }
  : T extends `${string}:${infer Param}`
    ? { [K in Param]: string }
    : Record<string, never>

/** Accept a single value or an array. */
export type OneOrMore<T> = T | T[]

/** Create a nominal/opaque type from a base type. */
export type Opaque<Base, Tag extends string> = Base & { readonly __tag: Tag }

/** Unwrap an opaque type back to its base. */
export type UnwrapOpaque<T> = T extends Opaque<infer Base, string> ? Base : T

/** Accept sync or async values. */
export type AsyncOrSync<T> = T | Promise<T>

/** Constructor type. */
// The default `Args` is `never[]`, not `unknown[]`: parameters are
// contravariant, so only a rest of `never` accepts EVERY concrete parameter
// list. Pass `Args` explicitly when you need to call the constructor.
export type Constructor<T = unknown, Args extends unknown[] = never[]> = new (...args: Args) => T

/** Abstract constructor type. */
export type AbstractConstructor<T = unknown> = abstract new (...args: unknown[]) => T

/** Extract only function property keys from a type, optionally excluding inherited ones. */
export type ExtractFunctions<T, Ignore extends keyof T = never> = {
  [K in Exclude<keyof T, Ignore>]: T[K] extends (...args: unknown[]) => unknown ? K : never
}[Exclude<keyof T, Ignore>]

/** Prettify a type intersection for better IDE display. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}

// ─── AdonisJS-style additions ─────────────────────────────

/** Extract keys whose value type may be undefined. */
export type ExtractUndefined<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T]

/** Extract keys whose value type cannot be undefined. */
export type ExtractDefined<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K
}[keyof T]

/** Lazy module import — `() => import('module')` returning a default export. */
export type LazyImport<T> = () => Promise<{ default: T }>

/** Unwrap the default export from a LazyImport type. */
export type UnWrapLazyImport<T> = T extends LazyImport<infer U> ? U : T

/** Unwrap a Promise type to its resolved value. */
export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T

/** Make specific keys optional. */
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/** Make specific keys required. */
export type MakeRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

/** Make specific keys nullable. */
export type MakeNullable<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null }

/** Recursively make all properties optional. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/** Recursively make all properties required. */
export type DeepRequired<T> = T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T

/** Recursively make all properties readonly. */
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T

/** An object with no properties (different from `{}` which accepts anything). */
export type EmptyObject = Record<string, never>

/** Extract keys whose value matches a given type. */
export type ExtractKeysOfType<T, V> = {
  [K in keyof T]: T[K] extends V ? K : never
}[keyof T]

/** All-of: every member of the union must satisfy. */
export type AllOf<T extends readonly unknown[]> = T extends readonly [infer Head, ...infer Tail]
  ? Head & AllOf<Tail>
  : unknown

/** None-of: a value that does not match any of the given types. */
export type NoneOf<T, Excluded> = T extends Excluded ? never : T

/** Type guard signature: `(value: unknown) => value is T`. */
export type TypeGuard<T> = (value: unknown) => value is T

/** Brand a primitive with a tag for nominal typing (alias for Opaque, AdonisJS naming). */
export type Brand<Base, Tag extends string> = Opaque<Base, Tag>

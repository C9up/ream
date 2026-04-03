/**
 * Type helpers — utility types for the Ream framework.
 */

/**
 * Infer route parameters from a route pattern string.
 *
 * Usage:
 *   type Params = InferRouteParams<'/users/:id/posts/:postId'>
 *   // => { id: string; postId: string }
 */
export type InferRouteParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
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
export type Constructor<T = unknown, Args extends unknown[] = unknown[]> = new (...args: Args) => T

/** Abstract constructor type. */
export type AbstractConstructor<T = unknown> = abstract new (...args: unknown[]) => T

/** Extract only function properties from a type. */
export type ExtractFunctions<T, Ignore extends keyof T = never> = {
  [K in Exclude<keyof T, Ignore>]: T[K] extends (...args: unknown[]) => unknown ? K : never
}[Exclude<keyof T, Ignore>]

/** Prettify a type intersection for better IDE display. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}

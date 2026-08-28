/**
 * Compose a class by applying mixins to it.
 *
 *   class User extends compose(BaseModel, SoftDeletes, Sluggable) {}
 *
 * Each mixin is a function taking the class built so far and returning a
 * subclass of it, so the chain is a plain left fold. Written out by hand that
 * is `Sluggable(SoftDeletes(BaseModel))`, which reads inside-out and gets
 * worse with every mixin — the whole point of the helper.
 *
 * The overloads exist so the RETURN type is the last mixin's, not the base
 * class's: without them a composed class would lose every member the mixins
 * added, statics included.
 *
 * Note there is no `Constructor` bound on `T`. The mixin's own parameter type
 * already constrains what can be passed, and a bound would have to be written
 * with `any` to admit a class with typed constructor arguments.
 */

/** A mixin: takes the class built so far, returns a subclass of it. */
type Mixin<T, R> = (superclass: T) => R

export function compose<T, A>(superclass: T, a: Mixin<T, A>): A
export function compose<T, A, B>(superclass: T, a: Mixin<T, A>, b: Mixin<A, B>): B
export function compose<T, A, B, C>(
  superclass: T,
  a: Mixin<T, A>,
  b: Mixin<A, B>,
  c: Mixin<B, C>,
): C
export function compose<T, A, B, C, D>(
  superclass: T,
  a: Mixin<T, A>,
  b: Mixin<A, B>,
  c: Mixin<B, C>,
  d: Mixin<C, D>,
): D
export function compose<T, A, B, C, D, E>(
  superclass: T,
  a: Mixin<T, A>,
  b: Mixin<A, B>,
  c: Mixin<B, C>,
  d: Mixin<C, D>,
  e: Mixin<D, E>,
): E
export function compose<T, A, B, C, D, E, F>(
  superclass: T,
  a: Mixin<T, A>,
  b: Mixin<A, B>,
  c: Mixin<B, C>,
  d: Mixin<C, D>,
  e: Mixin<D, E>,
  f: Mixin<E, F>,
): F
export function compose<T, A, B, C, D, E, F, G>(
  superclass: T,
  a: Mixin<T, A>,
  b: Mixin<A, B>,
  c: Mixin<B, C>,
  d: Mixin<C, D>,
  e: Mixin<D, E>,
  f: Mixin<E, F>,
  g: Mixin<F, G>,
): G
export function compose<T, A, B, C, D, E, F, G, H>(
  superclass: T,
  a: Mixin<T, A>,
  b: Mixin<A, B>,
  c: Mixin<B, C>,
  d: Mixin<C, D>,
  e: Mixin<D, E>,
  f: Mixin<E, F>,
  g: Mixin<F, G>,
  h: Mixin<G, H>,
): H

/**
 * The single implementation. Its parameters are deliberately looser than the
 * overloads above — a variadic fold cannot express "each mixin takes what the
 * previous one returned" — and the overloads are what callers see.
 */
export function compose(superclass: unknown, ...mixins: Mixin<unknown, unknown>[]): unknown {
  return mixins.reduce((applied, mixin) => mixin(applied), superclass)
}

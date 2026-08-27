/**
 * Give a subclass its own copy of an inherited static property.
 *
 * A static declared on a base class is SHARED: every subclass mutating
 * `Model.booted` or `Model.$columns` writes into the same object. This walks
 * that back by defining an own property on the subclass, seeded either from a
 * fresh value or from a copy of what it inherited.
 *
 * Ported from `@poppinss/utils` — the mechanism ORM-style base classes rely on.
 */
export function defineStaticProperty<T>(
  target: object,
  propertyName: string,
  options: { initialValue: T; strategy: 'inherit' | 'define' | ((value: T) => T) },
): void {
  if (Object.hasOwn(target, propertyName)) return

  const inherited: unknown = Reflect.get(target, propertyName)
  const { strategy, initialValue } = options

  const value =
    strategy === 'define' || inherited === undefined
      ? initialValue
      : typeof strategy === 'function'
        ? strategy(inherited as T)
        : structuredCloneOrCopy(inherited)

  Object.defineProperty(target, propertyName, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  })
}

/**
 * A deep copy where one is possible, a shallow one otherwise.
 *
 * `structuredClone` throws on functions and class instances, which a static
 * bag can legitimately hold — falling back keeps the inherit strategy usable
 * instead of failing at class-definition time.
 */
function structuredCloneOrCopy(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    if (Array.isArray(value)) return [...value]
    if (value !== null && typeof value === 'object') return { ...value }
    return value
  }
}

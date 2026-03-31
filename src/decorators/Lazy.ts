/**
 * @Lazy() decorator — deferred injection to break circular dependencies.
 *
 * @implements FR15
 */

import 'reflect-metadata'

const LAZY_KEY = Symbol.for('ream:lazy')

/**
 * @Lazy() — marks a constructor parameter for deferred resolution.
 * The dependency is resolved on first property access, not at construction.
 */
export function Lazy(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    const existing: number[] = Reflect.getOwnMetadata(LAZY_KEY, target, propertyKey ?? '') ?? []
    existing.push(parameterIndex)
    Reflect.defineMetadata(LAZY_KEY, existing, target, propertyKey ?? '')
  }
}

/** Get lazy parameter indices for a constructor. */
export function getLazyParams(target: Function): number[] {
  return Reflect.getOwnMetadata(LAZY_KEY, target, '') ?? []
}

/**
 * Create a lazy proxy that defers resolution until first access.
 * Traps get, set, has, ownKeys, getOwnPropertyDescriptor for full compatibility.
 */
export function createLazyProxy<T extends object>(resolver: () => T): T {
  let instance: T | undefined
  const ensure = (): T => { if (!instance) instance = resolver(); return instance }

  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      return Reflect.get(ensure(), prop, receiver)
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(ensure(), prop, value, receiver)
    },
    has(_target, prop) {
      return Reflect.has(ensure(), prop)
    },
    ownKeys() {
      return Reflect.ownKeys(ensure())
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(ensure(), prop)
    },
  })
}

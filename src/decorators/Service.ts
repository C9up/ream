/**
 * @Service() and @Inject() decorators for IoC container integration.
 *
 * @implements FR11, FR12, FR14
 */

import 'reflect-metadata'
import type { ServiceMetadata, ServiceScope, ServiceToken } from '../container/types.js'

const SERVICE_METADATA_KEY = Symbol('ream:service')
const INJECT_METADATA_KEY = Symbol('ream:inject')
const METHOD_INJECTIONS_KEY = Symbol('ream:method-injections')

/** Constructor type — accepts unknown args, returns unknown instance. */
// `never[]` accepts every constructor shape: parameters are contravariant, so a
// rest of `never` is assignable from any concrete list. Same spelling as the
// router's, so a class flows between the two without an assertion.
type AnyConstructor = abstract new (...args: never[]) => unknown

/** Registry of all decorated services. */
const serviceRegistry: Map<AnyConstructor, ServiceMetadata> = new Map()

export function getServiceRegistry(): ReadonlyMap<AnyConstructor, ServiceMetadata> {
  return serviceRegistry
}

/** Clear the service registry (for test isolation and hot-reload). */
export function clearServiceRegistry(): void {
  serviceRegistry.clear()
}

export function getServiceMetadata(target: AnyConstructor): ServiceMetadata | undefined {
  return serviceRegistry.get(target)
}

/**
 * @Service() decorator.
 * Registers the class in the IoC container for auto-resolution.
 */
/** Anything with a construct signature — a decorated class always is. */
function isConstructor(value: unknown): value is AnyConstructor {
  return typeof value === 'function' && value.prototype !== undefined
}

export function Service(options: { scope?: ServiceScope; as?: string } = {}): ClassDecorator {
  return (target) => {
    const metadata: ServiceMetadata = {
      scope: options.scope ?? 'singleton',
      as: options.as,
    }
    // A ClassDecorator's target is typed `Function`, which carries no
    // construct signature; the guard is what states that a decorated class IS
    // constructible.
    if (!isConstructor(target)) {
      throw new TypeError('@Service() can only decorate a class')
    }
    serviceRegistry.set(target, metadata)
    Reflect.defineMetadata(SERVICE_METADATA_KEY, metadata, target)
  }
}

/**
 * @Inject() decorator — marks a constructor parameter for named injection.
 *
 * @implements FR16
 */
export function Inject(token: ServiceToken): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    // A constructor parameter reports no property key and lands on the class;
    // a method parameter lands on the prototype and MUST be keyed by method
    // name, or every method of the class would share one map and overwrite
    // each other's tokens.
    const existingTokens: Map<number, ServiceToken> =
      (propertyKey === undefined
        ? Reflect.getOwnMetadata(INJECT_METADATA_KEY, target)
        : Reflect.getOwnMetadata(INJECT_METADATA_KEY, target, propertyKey)) ?? new Map()

    existingTokens.set(parameterIndex, token)

    if (propertyKey === undefined) {
      Reflect.defineMetadata(INJECT_METADATA_KEY, existingTokens, target)
    } else {
      Reflect.defineMetadata(INJECT_METADATA_KEY, existingTokens, target, propertyKey)
    }
  }
}

/**
 * Get named injection tokens for a class constructor.
 */
export function getInjectTokens(target: AnyConstructor): Map<number, ServiceToken> {
  return Reflect.getOwnMetadata(INJECT_METADATA_KEY, target) ?? new Map()
}

/**
 * Get named injection tokens for one method's parameters.
 *
 * `target` is the prototype carrying the method — that is where a parameter
 * decorator on a method writes.
 */
export function getMethodInjectTokens(
  target: object,
  propertyKey: string | symbol,
): Map<number, ServiceToken> {
  return Reflect.getOwnMetadata(INJECT_METADATA_KEY, target, propertyKey) ?? new Map()
}

/**
 * The parameter types `@inject()` recorded for one method, or `undefined`
 * when the method was not decorated (or the transpiler emitted no metadata).
 *
 * Read with `getMetadata`, not `getOwnMetadata`: a subclass inherits a
 * decorated method, and its injections with it.
 */
export function getMethodInjections(
  target: object,
  propertyKey: string | symbol,
): unknown[] | undefined {
  const recorded: unknown = Reflect.getMetadata(METHOD_INJECTIONS_KEY, target, propertyKey)
  return Array.isArray(recorded) ? recorded : undefined
}

/**
 * @inject() — AdonisJS fold's decorator, on a class or on a method.
 *
 * On a class: equivalent to `@Service({ scope: 'transient' })`, so the
 * container auto-resolves the constructor's dependencies per resolution.
 *
 *   @inject()
 *   export default class UsersController {
 *     constructor(private userService: UserService) {}
 *   }
 *
 * On a method: records the method's parameter types, which
 * `container.call(instance, method, runtimeValues)` resolves — every slot the
 * runtime values leave open, by type. The decorator's presence is also what
 * makes TypeScript emit those types at all. The class is not registered.
 *
 *   export default class UsersController {
 *     @inject()
 *     async index(ctx: HttpContext, users: UserService) { … }
 *   }
 */
export function inject(): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      if (typeof target !== 'function') {
        throw new TypeError('@inject() decorates a class or one of its methods')
      }
      Service({ scope: 'transient' })(target)
      return
    }
    const paramTypes: unknown = Reflect.getMetadata('design:paramtypes', target, propertyKey)
    if (Array.isArray(paramTypes)) {
      Reflect.defineMetadata(METHOD_INJECTIONS_KEY, [...paramTypes], target, propertyKey)
    }
  }
}

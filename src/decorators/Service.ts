/**
 * @Service() and @Inject() decorators for IoC container integration.
 *
 * @implements FR11, FR12, FR14
 */

import 'reflect-metadata'
import type { ServiceMetadata, ServiceScope, ServiceToken } from '../container/types.js'

const SERVICE_METADATA_KEY = Symbol('ream:service')
const INJECT_METADATA_KEY = Symbol('ream:inject')

/** Constructor type — accepts unknown args, returns unknown instance. */
type AnyConstructor = new (...args: unknown[]) => unknown

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
export function Service(options: { scope?: ServiceScope; as?: string } = {}): ClassDecorator {
  return (target) => {
    const metadata: ServiceMetadata = {
      scope: options.scope ?? 'singleton',
      as: options.as,
    }
    // biome-ignore lint/suspicious/noExplicitAny: ClassDecorator target is Function; registry requires AnyConstructor which is a subtype
    serviceRegistry.set(target as any as AnyConstructor, metadata)
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
 * @inject() class decorator — marks a controller (or service) for transient IoC resolution.
 *
 * Equivalent to @Service({ scope: 'transient' }). Use on controllers so the container
 * auto-resolves constructor dependencies per-request.
 *
 * Usage:
 *   @inject()
 *   export default class UsersController {
 *     constructor(private userService: UserService) {}
 *   }
 */
export function inject(): ClassDecorator {
  return Service({ scope: 'transient' })
}

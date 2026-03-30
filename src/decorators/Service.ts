/**
 * @Service() decorator — registers a class in the IoC container.
 *
 * @implements FR11
 *
 * Usage:
 *   @Service()
 *   class OrderService { }
 *
 *   @Service({ scope: 'transient' })
 *   class OrderDTO { }
 *
 *   @Service({ as: 'PaymentGateway' })
 *   class StripeGateway implements PaymentGateway { }
 */

import 'reflect-metadata'
import type { ServiceMetadata, ServiceScope } from '../container/types.js'

const SERVICE_METADATA_KEY = Symbol('ream:service')
const INJECT_METADATA_KEY = Symbol('ream:inject')

/** Registry of all decorated services. */
// biome-ignore lint/suspicious/noExplicitAny: Registry stores any constructor
const serviceRegistry: Map<new (...args: any[]) => any, ServiceMetadata> = new Map()

export function getServiceRegistry() {
  return serviceRegistry as ReadonlyMap<new (...args: any[]) => any, ServiceMetadata>
}

/** Clear the service registry (for test isolation). */
export function clearServiceRegistry(): void {
  serviceRegistry.clear()
}

export function getServiceMetadata(
  // biome-ignore lint/suspicious/noExplicitAny: Accepts any class
  target: new (...args: any[]) => any,
): ServiceMetadata | undefined {
  return serviceRegistry.get(target)
}

/**
 * @Service() decorator.
 * Registers the class in the IoC container for auto-resolution.
 */
export function Service(
  options: { scope?: ServiceScope; as?: string } = {},
): ClassDecorator {
  // biome-ignore lint/suspicious/noExplicitAny: Decorator target is any class
  return (target: any) => {
    const metadata: ServiceMetadata = {
      scope: options.scope ?? 'singleton',
      as: options.as,
    }
    serviceRegistry.set(target, metadata)
    Reflect.defineMetadata(SERVICE_METADATA_KEY, metadata, target)
  }
}

/**
 * @Inject() decorator — marks a constructor parameter for named injection.
 *
 * @implements FR16
 *
 * Usage:
 *   constructor(@Inject('PaymentGateway') private payment: PaymentGateway) {}
 */
export function Inject(token: string): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    const existingTokens: Map<number, string> =
      Reflect.getOwnMetadata(INJECT_METADATA_KEY, target) ?? new Map()
    existingTokens.set(parameterIndex, token)
    Reflect.defineMetadata(INJECT_METADATA_KEY, existingTokens, target)
  }
}

/**
 * Get named injection tokens for a class constructor.
 */
// biome-ignore lint/suspicious/noExplicitAny: Accepts any class
export function getInjectTokens(target: new (...args: any[]) => any): Map<number, string> {
  return Reflect.getOwnMetadata(INJECT_METADATA_KEY, target) ?? new Map()
}

export { SERVICE_METADATA_KEY, INJECT_METADATA_KEY }

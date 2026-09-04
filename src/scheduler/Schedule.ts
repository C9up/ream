/**
 * `@Schedule('cron-expr')` method decorator — declares a recurring task.
 *
 * Tasks are discovered at boot by `ScheduleProvider` iterating the IoC
 * service registry, reading this metadata, and registering each entry
 * with the Rust-backed `Scheduler` (Story 28.1). The Rust ticker owns
 * the loop; TypeScript only declares *what* runs and *when*.
 *
 * @implements Story 28.2
 */

import 'reflect-metadata'
import { ReamError } from '../errors/ReamError.js'
import type { Constructor } from '../helpers/types.js'

export const SCHEDULE_METADATA_KEY = Symbol('ream:schedule')

export interface ScheduleMetadata {
  cronExpr: string
  methodName: string | symbol
  target: Constructor
}

/**
 * Declares that a method should run on a cron schedule.
 *
 * Expressions are standard 5-field cron (minute hour day-of-month month
 * day-of-week), evaluated in **UTC** by the Rust core — callers that
 * want local-time semantics must pre-translate.
 *
 * Multiple `@Schedule` decorators on different methods of the same class
 * accumulate into an array rather than overwriting each other. Metadata
 * is stored with `Reflect.defineMetadata` under a stable symbol key on
 * the class constructor; inherited metadata is NOT shared (each class
 * owns its own array — subclasses that add schedules do not mutate the
 * base class's array).
 *
 * Getters, setters, and static methods are rejected at decoration time
 * with a clear `ReamError` so that misuse surfaces early rather than at
 * first fire.
 *
 * Usage:
 * ```ts
 * @Service()
 * class Cleanup {
 *   @Schedule('0 *\/5 * * *')
 *   async runCleanup() { ... }
 * }
 * ```
 */
export function Schedule(cronExpr: string): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    // Reject static methods. For a static, `target` IS the constructor
    // (callable function); for an instance method, `target` is the
    // prototype. We need the real class either way.
    if (typeof target === 'function') {
      throw new ReamError(
        'E_SCHEDULE_INVALID_TARGET',
        `@Schedule cannot be applied to static method '${String(propertyKey)}'`,
        {
          hint: 'Move the scheduled logic to an instance method, or register the task manually via Scheduler.register().',
        },
      )
    }

    // Reject getters/setters — `descriptor.value` is `undefined` for
    // accessors, and the ticker needs a callable method.
    if (descriptor && typeof descriptor.value !== 'function') {
      throw new ReamError(
        'E_SCHEDULE_INVALID_TARGET',
        `@Schedule cannot be applied to non-method '${String(propertyKey)}' (getters and setters are not supported)`,
        {
          hint: 'Apply @Schedule to a regular method, not to an accessor.',
        },
      )
    }

    const ctor = target.constructor as Constructor
    // getOwnMetadata — do NOT walk the prototype chain. A subclass must
    // not mutate the base class's shared array; each class owns its own
    // schedule list. Matches the convention in decorators/Service.ts.
    const existing: ScheduleMetadata[] = Reflect.getOwnMetadata(SCHEDULE_METADATA_KEY, ctor) ?? []
    existing.push({ cronExpr, methodName: propertyKey, target: ctor })
    Reflect.defineMetadata(SCHEDULE_METADATA_KEY, existing, ctor)
  }
}

/**
 * Return every `@Schedule` entry declared on `target` (empty array if
 * none). Returns a shallow copy so callers cannot mutate the stored
 * metadata by accident.
 */
/**
 * `abstract new`, not `Constructor`: reading metadata off a class never
 * constructs it, and the service registry holds abstract ones too since a
 * contextual binding binds against an abstract base.
 */
export function getScheduleMetadata(
  target: abstract new (...args: never[]) => unknown,
): ScheduleMetadata[] {
  const stored: ScheduleMetadata[] = Reflect.getOwnMetadata(SCHEDULE_METADATA_KEY, target) ?? []
  return [...stored]
}

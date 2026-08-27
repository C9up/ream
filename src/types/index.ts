/**
 * The interfaces an application or a package augments.
 *
 * Resolving from the container and picking an auth guard are both string
 * lookups; without a shared interface to augment, every call site casts. This
 * is the module those interfaces live in — `@c9up/ream/types`.
 */

export type { AuthenticatorName, Authenticators } from './authenticators.js'
export type { ContainerBinding, ContainerBindings } from './container.js'

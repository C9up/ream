/**
 * Container types and interfaces.
 * @implements FR11, FR14, FR16
 */

/** Service scope determines instance lifecycle. */
export type ServiceScope = 'singleton' | 'transient' | 'request'

/** Service metadata stored by @Service() decorator. */
export interface ServiceMetadata {
  scope: ServiceScope
  /** If set, binds as this named interface instead of the class itself. */
  as?: string
}

/** Token used to resolve a service — either a class constructor or a string name. */
export type ServiceToken = (new (...args: unknown[]) => unknown) | string

/** Factory function for creating service instances. */
export type ServiceFactory = () => unknown

/** Binding entry in the container. */
export interface Binding {
  token: ServiceToken
  factory?: ServiceFactory
  instance?: unknown
  scope: ServiceScope
  dependencies: ServiceToken[]
}

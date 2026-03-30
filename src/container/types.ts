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
// biome-ignore lint/suspicious/noExplicitAny: Container needs to accept any constructor
export type ServiceToken = (new (...args: any[]) => any) | string

/** Factory function for creating service instances. */
// biome-ignore lint/suspicious/noExplicitAny: Factory returns any service type
export type ServiceFactory = (...args: any[]) => any

/** Binding entry in the container. */
export interface Binding {
  token: ServiceToken
  factory?: ServiceFactory
  instance?: unknown
  scope: ServiceScope
  dependencies: ServiceToken[]
}

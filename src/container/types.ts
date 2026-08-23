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

/** Token used to resolve a service — class constructor, string name, or registered symbol. */
// `never[]` accepts every constructor shape — parameters are contravariant, so
// a rest of `never` is assignable from any concrete list.
export type ServiceToken = (new (...args: never[]) => unknown) | string | symbol

/**
 * Resolver handed to a binding factory so it can resolve its own dependencies
 * (AdonisJS parity: `container.singleton(token, async (resolver) =>
 * await resolver.make(Dep))`). The Container itself satisfies this contract.
 */
export interface ContainerResolver {
  make<T>(token: ServiceToken, runtimeValues?: unknown[]): Promise<T>
}

/**
 * Factory function for creating service instances. Receives a {@link
 * ContainerResolver} (AdonisJS parity) — the async container means a factory
 * that needs another binding must `await resolver.make(Dep)`.
 */
export type ServiceFactory = (resolver: ContainerResolver) => unknown

/** Binding entry in the container. */
export interface Binding {
  token: ServiceToken
  factory?: ServiceFactory
  instance?: unknown
  scope: ServiceScope
  dependencies: ServiceToken[]
}

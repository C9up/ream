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
/**
 * What the container accepts as a token.
 *
 * `abstract new`, not `new`: binding an implementation against an abstract base
 * is the whole point of a contextual binding — `@Inject(Hash)` where `Hash` is
 * the abstract class and `Bcrypt` is what the container provides. An abstract
 * class has no construct signature, so spelt `new (...)` the type rejected
 * exactly the pattern the feature exists for. `abstract new` admits concrete
 * classes too.
 */
export type ServiceToken = (abstract new (...args: never[]) => unknown) | string | symbol

/**
 * What a binding factory is handed so it can resolve its own dependencies
 * (AdonisJS parity: `container.singleton(token, async (resolver) =>
 * await resolver.make(Dep))`).
 *
 * Narrow on purpose: both the `Container` and a per-request `ContainerResolver`
 * satisfy it, so a factory works the same whichever one is resolving.
 */
export interface FactoryResolver {
  make<T>(token: ServiceToken, runtimeValues?: unknown[]): Promise<T>
  /**
   * Call a method with its dependencies injected. Declared here because a
   * factory that dispatches to a handler needs it and both implementations
   * have it — leaving it off did not make the capability go away, it only
   * hid it from the callers allowed to use it.
   */
  call<T, K extends string & keyof T>(
    instance: T,
    method: K,
    runtimeValues?: unknown[],
  ): Promise<unknown>
}

/**
 * Factory function for creating service instances. Receives a {@link
 * FactoryResolver} (AdonisJS parity) — the async container means a factory
 * that needs another binding must `await resolver.make(Dep)`.
 */
export type ServiceFactory = (resolver: FactoryResolver) => unknown

/**
 * Decides whether a conditional binding answers this resolution (AdonisJS
 * `BindingCondition`). `runtimeValues` are those given to `make()`/`call()` —
 * a class's own dependencies receive `undefined`; `parent` is the class asking,
 * or `null` when the binding is resolved directly.
 */
export type BindingCondition = (
  resolver: FactoryResolver,
  runtimeValues: unknown[] | undefined,
  parent: (abstract new (...args: never[]) => unknown) | null,
) => boolean | Promise<boolean>

/**
 * What the container tells about each resolution, when it has an emitter
 * (AdonisJS `ContainerOptions.emitter`). The event is
 * `container_binding:resolved`, with `{ binding, value }`.
 */
export interface ContainerEmitter {
  emit(event: string, data: unknown): unknown
}

/** Options of the `Container` constructor (AdonisJS `ContainerOptions`). */
export interface ContainerOptions {
  emitter?: ContainerEmitter
}

/** Binding entry in the container. */
export interface Binding {
  token: ServiceToken
  factory?: ServiceFactory
  instance?: unknown
  scope: ServiceScope
  dependencies: ServiceToken[]
}

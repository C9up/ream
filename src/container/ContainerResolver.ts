/**
 * Per-request view of the {@link Container} — AdonisJS Fold's
 * `ContainerResolver`.
 *
 * A resolver resolves exactly what the container resolves, plus the values
 * bound on it with {@link ContainerResolver.bindValue}. Those values are
 * ISOLATED: they are visible to everything this resolver builds, including the
 * constructor dependencies of what it builds, and to nothing else. That is what
 * makes it safe for the HTTP kernel to bind one request's `HttpContext` — on
 * the container itself, the binding would leak into every other request.
 *
 *     const resolver = container.createResolver()
 *     resolver.bindValue(HttpContext, ctx)
 *     await resolver.make(UsersController) // gets this request's ctx
 */

import type { Container } from './Container.js'
import type { ServiceToken } from './types.js'

export class ContainerResolver {
  readonly #container: Container
  /** Values bound here, keyed the way the container keys its tokens. */
  readonly #values = new Map<string, unknown>()

  constructor(container: Container) {
    this.#container = container
  }

  /**
   * Bind a resolved value for this resolver only (AdonisJS
   * `resolver.bindValue`). Rebinding the same token replaces it.
   */
  bindValue<T>(token: ServiceToken, value: T): void {
    this.#values.set(this.#container.keyFor(token), value)
  }

  /**
   * Resolve a token, seeing this resolver's values first (AdonisJS
   * `resolver.make`).
   */
  make<T>(token: ServiceToken, runtimeValues?: unknown[]): Promise<T> {
    return this.#container.runWithScopedValues(this.#values, () =>
      this.#container.make<T>(token, runtimeValues),
    )
  }

  /**
   * Call a method with its dependencies injected, seeing this resolver's
   * values (AdonisJS `resolver.call`).
   */
  call<T, K extends string & keyof T>(
    instance: T,
    method: K,
    runtimeValues?: unknown[],
  ): Promise<unknown> {
    return this.#container.runWithScopedValues(this.#values, () =>
      this.#container.call(instance, method, runtimeValues),
    )
  }

  /**
   * Resolve as if `parent` had asked, so `parent`'s contextual bindings apply
   * (AdonisJS `resolver.resolveFor`). `null` means nobody asked.
   */
  resolveFor<T>(
    parent: (new (...args: never[]) => unknown) | null,
    token: ServiceToken,
    runtimeValues?: unknown[],
  ): Promise<T> {
    return this.#container.runWithScopedValues(this.#values, () =>
      this.#container.resolveFor<T>(parent, token, runtimeValues),
    )
  }

  /** Whether the token resolves — here or on the container (AdonisJS `hasBinding`). */
  hasBinding(token: ServiceToken): boolean {
    return this.#values.has(this.#container.keyFor(token)) || this.#container.has(token)
  }

  /** Whether every token resolves (AdonisJS `hasAllBindings`). */
  hasAllBindings(tokens: ServiceToken[]): boolean {
    return tokens.every((token) => this.hasBinding(token))
  }
}

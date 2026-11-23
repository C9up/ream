/**
 * The fluent form of a contextual binding — AdonisJS `container.when()`.
 *
 *     container.when(UsersController).asksFor(Hash).provide(() => new Argon2())
 *
 * Reads as the sentence it is: when THIS class asks for THAT, give it this.
 * `container.contextualBinding(parent, binding, factory)` is the same thing in
 * one call.
 */

import { E_CONTAINER_MISSING_ASKS_FOR } from '../errors/codes.js'
import type { Container } from './Container.js'
import type { ServiceFactory, ServiceToken } from './types.js'

export class ContextualBindingsBuilder {
  readonly #container: Container
  readonly #parent: new (
    ...args: never[]
  ) => unknown
  #binding: ServiceToken | undefined

  constructor(container: Container, parent: new (...args: never[]) => unknown) {
    this.#container = container
    this.#parent = parent
  }

  /** The dependency this class asks for. */
  asksFor(binding: ServiceToken): this {
    this.#binding = binding
    return this
  }

  /** What it gets instead. */
  provide(factory: ServiceFactory): void {
    if (this.#binding === undefined) {
      throw new E_CONTAINER_MISSING_ASKS_FOR()
    }
    this.#container.contextualBinding(this.#parent, this.#binding, factory)
  }
}

/**
 * The fluent form of a conditional binding — AdonisJS `container.if()`.
 *
 *     container.if((resolver) => flags.beta).bind(PaymentGateway, () => new BetaGateway())
 *
 * `container.conditionalBinding(condition, binding, factory, isSingleton)` is
 * the same thing in one call.
 */

import type { Container } from './Container.js'
import type { BindingCondition, ServiceFactory, ServiceToken } from './types.js'

export class ConditionalBindingsBuilder {
  readonly #container: Container
  readonly #condition: BindingCondition

  constructor(condition: BindingCondition, container: Container) {
    this.#condition = condition
    this.#container = container
  }

  /** A new value for each resolution while the condition holds. */
  bind(binding: ServiceToken, factory: ServiceFactory): void {
    this.#container.conditionalBinding(this.#condition, binding, factory, false)
  }

  /** One value, built the first time the condition holds, then reused. */
  singleton(binding: ServiceToken, factory: ServiceFactory): void {
    this.#container.conditionalBinding(this.#condition, binding, factory, true)
  }
}

/**
 * IoC Container — auto-resolves dependencies from @Service() decorated classes.
 *
 * @implements FR11, FR12, FR14, FR16
 */

import 'reflect-metadata'
import {
  getInjectTokens,
  getServiceMetadata,
  getServiceRegistry,
} from '../decorators/Service.js'
import { didYouMean } from '../errors/FuzzyMatcher.js'
import { ReamError } from '../errors/ReamError.js'
import type { Binding, ServiceFactory, ServiceScope, ServiceToken } from './types.js'

export class Container {
  private bindings: Map<string, Binding> = new Map()
  private singletons: Map<string, unknown> = new Map()
  private overrides: Map<string, ServiceFactory> = new Map()
  /** Resolution stack for circular dependency detection. */
  private resolutionStack: string[] = []

  /**
   * Register a singleton binding.
   */
  singleton<T>(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.tokenToKey(token)
    this.bindings.set(key, {
      token,
      factory,
      scope: 'singleton',
      dependencies: [],
    })
  }

  /**
   * Register a transient binding (new instance per resolve).
   */
  bind<T>(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.tokenToKey(token)
    this.bindings.set(key, {
      token,
      factory,
      scope: 'transient',
      dependencies: [],
    })
  }

  /**
   * Override a binding (for testing).
   * @implements FR12
   */
  override(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.tokenToKey(token)
    this.overrides.set(key, factory)
    // Clear cached singleton if exists
    this.singletons.delete(key)
  }

  /**
   * Restore all overrides (reset to original bindings).
   */
  restore(): void {
    // Only clear singletons that were overridden, not all cached singletons
    for (const key of this.overrides.keys()) {
      this.singletons.delete(key)
    }
    this.overrides.clear()
  }

  /**
   * Resolve a service by token.
   * Auto-resolves constructor dependencies recursively.
   */
  resolve<T>(token: ServiceToken): T {
    const key = this.tokenToKey(token)

    // Circular dependency detection
    if (this.resolutionStack.includes(key)) {
      const cycle = [...this.resolutionStack, key].join(' → ')
      throw new ReamError('CIRCULAR_DEPENDENCY', `Circular dependency detected: ${cycle}`, {
        hint: 'Fix options: 1. Use container.singleton() with explicit factory. 2. Decouple via Pulsar event instead of direct injection.',
        context: { chain: cycle },
      })
    }
    this.resolutionStack.push(key)

    try {
      return this._resolveInner<T>(key, token)
    } finally {
      this.resolutionStack.pop()
    }
  }

  private _resolveInner<T>(key: string, token: ServiceToken): T {
    // Check overrides first
    if (this.overrides.has(key)) {
      const factory = this.overrides.get(key)!
      return factory() as T
    }

    // Check for cached singleton
    if (this.singletons.has(key)) {
      return this.singletons.get(key) as T
    }

    // Check explicit bindings
    if (this.bindings.has(key)) {
      const binding = this.bindings.get(key)!
      const instance = binding.factory ? binding.factory() : undefined
      if (binding.scope === 'singleton') {
        this.singletons.set(key, instance)
      }
      return instance as T
    }

    // Auto-resolve from @Service() registry
    if (typeof token === 'function') {
      return this.autoResolve(token) as T
    }

    const allKeys = [...this.bindings.keys(), ...this.overrides.keys()]
    const suggestion = didYouMean(key, allKeys)
    throw new ReamError('CONTAINER_NOT_FOUND', `No binding found for '${key}'.${suggestion ? ` ${suggestion}` : ''}`, {
      hint: 'Register it with container.singleton() or decorate with @Service().',
    })
  }

  /**
   * Auto-resolve a @Service() decorated class by reading its constructor metadata.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Resolves any decorated class
  private autoResolve(target: new (...args: any[]) => any): unknown {
    const metadata = getServiceMetadata(target)
    if (!metadata) {
      throw new ReamError('CONTAINER_NOT_DECORATED', `Class '${target.name}' is not decorated with @Service().`, {
        hint: 'Add @Service() or register it manually with container.singleton().',
      })
    }

    const key = metadata.as ?? target.name

    // Check cached singleton
    if (metadata.scope === 'singleton' && this.singletons.has(key)) {
      return this.singletons.get(key)
    }

    // Get constructor parameter types via reflect-metadata
    const paramTypes: unknown[] =
      Reflect.getMetadata('design:paramtypes', target) ?? []
    const injectTokens = getInjectTokens(target)

    // Resolve each dependency
    const deps = paramTypes.map((type, index) => {
      // Named injection via @Inject('name')
      const namedToken = injectTokens.get(index)
      if (namedToken) {
        return this.resolve(namedToken)
      }
      // Auto-resolve by type
      if (typeof type === 'function' && type !== Object) {
        return this.resolve(type as ServiceToken)
      }
      return undefined
    })

    const instance = new target(...deps)

    if (metadata.scope === 'singleton') {
      this.singletons.set(key, instance)
    }

    return instance
  }

  /**
   * Auto-register all @Service() decorated classes from the registry.
   */
  autoRegister(): void {
    for (const [target, metadata] of getServiceRegistry()) {
      const key = metadata.as ?? target.name
      if (!this.bindings.has(key)) {
        const targetClass = target
        this.bindings.set(key, {
          token: metadata.as ?? target,
          factory: () => this.autoResolve(targetClass),
          scope: metadata.scope,
          dependencies: [],
        })
      }
    }
  }

  /**
   * Check if a token is registered.
   */
  has(token: ServiceToken): boolean {
    const key = this.tokenToKey(token)
    return (
      this.bindings.has(key) ||
      this.overrides.has(key) ||
      (typeof token === 'function' && getServiceMetadata(token) !== undefined)
    )
  }

  /**
   * Get the number of registered bindings.
   */
  get size(): number {
    return this.bindings.size
  }

  private tokenToKey(token: ServiceToken): string {
    if (typeof token === 'string') return token
    return token.name
  }
}

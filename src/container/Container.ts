/**
 * IoC Container — AdonisJS Fold-compatible dependency injection.
 *
 * - make(Class) auto-constructs any class with @inject(), no explicit binding needed
 * - call(instance, 'method') for method-level injection
 * - singleton() / bind() for explicit factory bindings
 * - swap() / restore() for testing
 *
 * @implements FR11, FR12, FR14, FR16
 */

import 'reflect-metadata'
import {
  getInjectTokens,
  getServiceMetadata,
  getServiceRegistry,
} from '../decorators/Service.js'
import { createLazyProxy, getLazyParams } from '../decorators/Lazy.js'
import { didYouMean } from '../errors/FuzzyMatcher.js'
import { ReamError } from '../errors/ReamError.js'
import type { Binding, ServiceFactory, ServiceScope, ServiceToken } from './types.js'

export class Container {
  private bindings: Map<string, Binding> = new Map()
  private singletons: Map<string, unknown> = new Map()
  private overrides: Map<string, ServiceFactory> = new Map()
  private resolutionStack: string[] = []

  // ─── Explicit bindings ────────────────────────────────────

  /** Register a singleton binding (factory called once, cached). */
  singleton<T>(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.tokenToKey(token)
    this.bindings.set(key, { token, factory, scope: 'singleton', dependencies: [] })
  }

  /** Register a transient binding (new instance per resolve). */
  bind<T>(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.tokenToKey(token)
    this.bindings.set(key, { token, factory, scope: 'transient', dependencies: [] })
  }

  /** Bind an existing value directly. */
  bindValue<T>(token: ServiceToken, value: T): void {
    const key = this.tokenToKey(token)
    this.singletons.set(key, value)
    this.bindings.set(key, { token, factory: () => value, scope: 'singleton', dependencies: [] })
  }

  // ─── Testing ──────────────────────────────────────────────

  /** Override a binding for testing (like AdonisJS container.swap). */
  swap(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.tokenToKey(token)
    this.overrides.set(key, factory)
    this.singletons.delete(key)
  }

  /** @deprecated Use swap() instead. */
  override(token: ServiceToken, factory: ServiceFactory): void {
    this.swap(token, factory)
  }

  /** Restore a specific swap, or all swaps if no token given. */
  restore(token?: ServiceToken): void {
    if (token) {
      const key = this.tokenToKey(token)
      this.overrides.delete(key)
      this.singletons.delete(key)
    } else {
      for (const key of this.overrides.keys()) {
        this.singletons.delete(key)
      }
      this.overrides.clear()
    }
  }

  // ─── Resolution ───────────────────────────────────────────

  /**
   * Resolve/construct a class or binding.
   * Like AdonisJS `container.make()`:
   * 1. Check swaps (test overrides)
   * 2. Check cached singletons
   * 3. Check explicit bindings (singleton/bind)
   * 4. Auto-construct if class has @inject() or @Service()
   * 5. Auto-construct any class (plain `new Class()`) as fallback
   */
  make<T>(token: ServiceToken): T {
    return this.resolve<T>(token)
  }

  /** Alias for make() — backward compatible. */
  resolve<T>(token: ServiceToken): T {
    const key = this.tokenToKey(token)

    if (this.resolutionStack.includes(key)) {
      const cycle = [...this.resolutionStack, key].join(' → ')
      throw new ReamError('CIRCULAR_DEPENDENCY', `Circular dependency detected: ${cycle}`, {
        hint: 'Use @Lazy() on one of the constructor parameters to break the cycle.',
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

  /**
   * Call a method on an instance with dependency injection.
   * Like AdonisJS `container.call()`.
   * Resolves method parameters from reflect-metadata and @inject().
   */
  async call<T, K extends keyof T>(
    instance: T,
    method: K,
    runtimeValues?: unknown[],
  ): Promise<unknown> {
    const target = instance.constructor as new (...args: unknown[]) => unknown
    const paramTypes: unknown[] = Reflect.getMetadata('design:paramtypes', target.prototype, method as string) ?? []

    const args = paramTypes.map((type, index) => {
      // Runtime values take precedence
      if (runtimeValues && index < runtimeValues.length) {
        return runtimeValues[index]
      }
      // Auto-resolve class dependencies
      if (typeof type === 'function' && type !== Object) {
        return this.resolve(type as ServiceToken)
      }
      return undefined
    })

    const fn = instance[method] as (...args: unknown[]) => unknown
    return fn.apply(instance, args)
  }

  // ─── Introspection ────────────────────────────────────────

  /** Check if a token is registered or resolvable. */
  has(token: ServiceToken): boolean {
    const key = this.tokenToKey(token)
    return (
      this.bindings.has(key) ||
      this.overrides.has(key) ||
      this.singletons.has(key) ||
      (typeof token === 'function' && getServiceMetadata(token) !== undefined)
    )
  }

  get size(): number {
    return this.bindings.size
  }

  /** Auto-register all @Service() decorated classes from the global registry. */
  autoRegister(): void {
    for (const [target, metadata] of getServiceRegistry()) {
      const key = metadata.as ?? target.name
      if (!this.bindings.has(key)) {
        const targetClass = target
        this.bindings.set(key, {
          token: metadata.as ?? target,
          factory: () => this.autoConstruct(targetClass),
          scope: metadata.scope,
          dependencies: [],
        })
      }
    }
  }

  // ─── Internal resolution ──────────────────────────────────

  private _resolveInner<T>(key: string, token: ServiceToken): T {
    // 1. Check swaps (test overrides)
    if (this.overrides.has(key)) {
      return this.overrides.get(key)!() as T
    }

    // 2. Check cached singletons
    if (this.singletons.has(key)) {
      return this.singletons.get(key) as T
    }

    // 3. Check explicit bindings
    if (this.bindings.has(key)) {
      const binding = this.bindings.get(key)!
      const instance = binding.factory ? binding.factory() : undefined
      if (binding.scope === 'singleton') {
        this.singletons.set(key, instance)
      }
      return instance as T
    }

    // 4. Auto-construct if it's a class
    if (typeof token === 'function') {
      return this.autoConstruct(token) as T
    }

    // 5. Not found
    const allKeys = [...this.bindings.keys(), ...this.overrides.keys()]
    const suggestion = didYouMean(key, allKeys)
    throw new ReamError('CONTAINER_NOT_FOUND', `No binding found for '${key}'.${suggestion ? ` ${suggestion}` : ''}`, {
      hint: 'Register it with container.singleton() or decorate with @inject().',
    })
  }

  /**
   * Auto-construct a class by reading its dependency hints.
   *
   * Resolution order (like AdonisJS Fold):
   * 1. static containerInjections._constructor.dependencies — explicit deps array
   * 2. Reflect.getMetadata('design:paramtypes') — decorator metadata (requires SWC/tsc)
   * 3. No params → plain `new Class()`
   */
  private autoConstruct(target: new (...args: unknown[]) => unknown): unknown {
    const metadata = getServiceMetadata(target)
    const scope = metadata?.scope ?? 'transient'
    const key = metadata?.as ?? target.name

    if (scope === 'singleton' && this.singletons.has(key)) {
      return this.singletons.get(key)
    }

    // 1. Check static containerInjections (AdonisJS Fold-compatible, works without emitDecoratorMetadata)
    const injections = (target as { containerInjections?: { _constructor?: { dependencies: ServiceToken[] } } }).containerInjections
    const explicitDeps = injections?._constructor?.dependencies

    // 2. Fallback to reflect-metadata
    const paramTypes: unknown[] = explicitDeps ?? (Reflect.getMetadata('design:paramtypes', target) ?? [])

    if (paramTypes.length === 0) {
      const instance = new target()
      if (scope === 'singleton') this.singletons.set(key, instance)
      return instance
    }

    const injectTokens = getInjectTokens(target)
    const lazyIndices = getLazyParams(target)

    const deps = paramTypes.map((type, index) => {
      const namedToken = injectTokens.get(index)
      const depToken: ServiceToken | undefined = namedToken
        ?? (typeof type === 'function' && type !== Object ? type as ServiceToken : undefined)

      if (!depToken) return undefined

      if (lazyIndices.includes(index)) {
        return createLazyProxy(() => this.resolve(depToken) as object)
      }

      return this.resolve(depToken)
    })

    const instance = new target(...deps)
    if (scope === 'singleton') this.singletons.set(key, instance)
    return instance
  }

  private tokenToKey(token: ServiceToken): string {
    if (typeof token === 'string') return token
    return token.name
  }
}

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
import { createLazyProxy, getLazyParams } from '../decorators/Lazy.js'
import { getInjectTokens, getServiceMetadata, getServiceRegistry } from '../decorators/Service.js'
import { didYouMean } from '../errors/FuzzyMatcher.js'
import { ReamError } from '../errors/ReamError.js'
import type { Binding, ServiceFactory, ServiceToken } from './types.js'

/**
 * Symbol descriptions that would collide with object-prototype keys if used
 * as raw map keys. We reject them on registration so tokens cannot be used
 * as a prototype-pollution vector.
 */
const RESERVED_TOKEN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export class Container {
  #bindings: Map<string, Binding> = new Map()
  #singletons: Map<string, unknown> = new Map()
  #overrides: Map<string, ServiceFactory> = new Map()
  /**
   * Snapshot of singletons taken when `swap`/`override` shadows a previously
   * resolved instance. `restore()` re-seats them without re-invoking the
   * original factory, so callers that captured the live reference keep
   * pointing at the same object after the test ends.
   */
  #singletonBackup: Map<string, unknown> = new Map()
  /** Alias key → the token it forwards to (AdonisJS `container.alias`). */
  #aliases: Map<string, ServiceToken> = new Map()
  /** token key → post-resolution callbacks (AdonisJS `container.resolving`). */
  #resolvingHooks: Map<string, Array<(value: unknown) => void>> = new Map()
  #resolutionStack: string[] = []
  #resolutionSet: Set<string> = new Set()

  // ─── Explicit bindings ────────────────────────────────────

  /** Register a singleton binding (factory called once, cached). */
  singleton<_T>(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.#tokenToKey(token)
    this.#bindings.set(key, { token, factory, scope: 'singleton', dependencies: [] })
  }

  /** Register a transient binding (new instance per resolve). */
  bind<_T>(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.#tokenToKey(token)
    this.#bindings.set(key, { token, factory, scope: 'transient', dependencies: [] })
  }

  /** Bind an existing value directly. */
  bindValue<T>(token: ServiceToken, value: T): void {
    const key = this.#tokenToKey(token)
    this.#singletons.set(key, value)
    this.#bindings.set(key, { token, factory: () => value, scope: 'singleton', dependencies: [] })
  }

  /**
   * Register an alias — resolving `alias` forwards to `target` (AdonisJS
   * `container.alias('db', Database)`). The target may be a class, string, or
   * symbol that itself resolves to a binding or an auto-constructable class.
   */
  alias(alias: ServiceToken, target: ServiceToken): void {
    this.#aliases.set(this.#tokenToKey(alias), target)
  }

  /**
   * Register a callback that runs each time `token` is constructed (AdonisJS
   * `container.resolving`) — for lazy init (`db.connect()`) or decorating the
   * resolved instance. Runs after construction of a binding/auto-constructed
   * class; NOT for raw `bindValue` values or an already-cached singleton.
   */
  resolving(token: ServiceToken, callback: (value: unknown) => void): void {
    const key = this.#tokenToKey(token)
    const hooks = this.#resolvingHooks.get(key)
    if (hooks) hooks.push(callback)
    else this.#resolvingHooks.set(key, [callback])
  }

  #runResolvingHooks(key: string, value: unknown): void {
    const hooks = this.#resolvingHooks.get(key)
    if (hooks) for (const hook of hooks) hook(value)
  }

  // ─── Testing ──────────────────────────────────────────────

  /**
   * Replace a binding's factory for testing (AdonisJS-compatible swap).
   * Snapshots the existing singleton (if any) so `restore()` re-seats the
   * original instance instead of re-invoking the underlying factory.
   */
  swap(token: ServiceToken, factory: ServiceFactory): void {
    const key = this.#tokenToKey(token)
    if (!this.#overrides.has(key) && this.#singletons.has(key)) {
      this.#singletonBackup.set(key, this.#singletons.get(key))
    }
    this.#overrides.set(key, factory)
    this.#singletons.delete(key)
  }

  /**
   * Replace a binding with a literal value for testing. The value is wrapped
   * as a factory internally, so each `resolve()` call returns it unchanged.
   * Pair with `restore()` to undo without losing the original singleton's
   * identity.
   */
  override<T>(token: ServiceToken, value: T): void {
    this.swap(token, () => value)
  }

  /** Restore a specific swap, or all swaps if no token given. */
  restore(token?: ServiceToken): void {
    if (token) {
      this.#restoreOne(this.#tokenToKey(token))
      return
    }
    for (const key of [...this.#overrides.keys()]) {
      this.#restoreOne(key)
    }
  }

  #restoreOne(key: string): void {
    this.#overrides.delete(key)
    this.#singletons.delete(key)
    if (this.#singletonBackup.has(key)) {
      this.#singletons.set(key, this.#singletonBackup.get(key))
      this.#singletonBackup.delete(key)
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
  make<T>(token: ServiceToken, runtimeValues?: unknown[]): T {
    return this.resolve<T>(token, runtimeValues)
  }

  /**
   * Alias for make() — backward compatible. `runtimeValues` fill the resolved
   * class's constructor slots by index (AdonisJS `make(Class, [req, res])`);
   * only the `undefined` slots are container-resolved. They apply to the
   * top-level construction only, never to nested dependencies.
   */
  resolve<T>(token: ServiceToken, runtimeValues?: unknown[]): T {
    // Dereference an alias to its target before anything else.
    const aliasTarget = this.#aliases.get(this.#tokenToKey(token))
    if (aliasTarget !== undefined) return this.resolve<T>(aliasTarget, runtimeValues)

    const key = this.#tokenToKey(token)

    if (this.#resolutionSet.has(key)) {
      const cycle = [...this.#resolutionStack, key].join(' → ')
      throw new ReamError('CIRCULAR_DEPENDENCY', `Circular dependency detected: ${cycle}`, {
        hint: 'Use @Lazy() on one of the constructor parameters to break the cycle.',
        context: { chain: cycle },
      })
    }
    this.#resolutionStack.push(key)
    this.#resolutionSet.add(key)

    try {
      return this.#resolveInner<T>(key, token, runtimeValues)
    } finally {
      this.#resolutionStack.pop()
      this.#resolutionSet.delete(key)
    }
  }

  /**
   * Call a method on an instance with dependency injection.
   * Like AdonisJS `container.call()`.
   * Resolves method parameters from reflect-metadata and @inject().
   */
  async call<T, K extends string & keyof T>(
    instance: T,
    method: K,
    runtimeValues?: unknown[],
  ): Promise<unknown> {
    type Ctor = new (...args: unknown[]) => unknown
    // `Object.getPrototypeOf` is typed `any` in lib.dom, so the assignment
    // narrows it back to a typed constructor without a cast expression.
    const target: Ctor = Object.getPrototypeOf(instance).constructor
    const paramTypes: unknown[] =
      Reflect.getMetadata('design:paramtypes', target.prototype, method) ?? []

    const len = Math.max(paramTypes.length, runtimeValues?.length ?? 0)
    const args = Array.from({ length: len }, (_, index) => {
      // Runtime values take precedence (and fill slots beyond paramTypes)
      if (runtimeValues && index < runtimeValues.length) return runtimeValues[index]
      const type = paramTypes[index]
      if (isInjectableClass(type)) return this.resolve(type)
      return undefined
    })

    const member: unknown = instance[method]
    if (!isCallable(member)) {
      throw new Error(`Container.call: '${method}' is not a callable method`)
    }
    return member.apply(instance, args)
  }

  // ─── Introspection ────────────────────────────────────────

  /** Check if a token is registered or resolvable. */
  has(token: ServiceToken): boolean {
    const key = this.#tokenToKey(token)
    return (
      this.#bindings.has(key) ||
      this.#overrides.has(key) ||
      this.#singletons.has(key) ||
      this.#aliases.has(key) ||
      (typeof token === 'function' && getServiceMetadata(token) !== undefined)
    )
  }

  /** True only when EVERY token is registered/resolvable (AdonisJS `hasAllBindings`). */
  hasAllBindings(tokens: ServiceToken[]): boolean {
    return tokens.every((token) => this.has(token))
  }

  get size(): number {
    return this.#bindings.size
  }

  /** Auto-register all @Service() decorated classes from the global registry. */
  autoRegister(): void {
    for (const [target, metadata] of getServiceRegistry()) {
      const key = metadata.as ?? target.name
      if (!this.#bindings.has(key)) {
        const targetClass = target
        this.#bindings.set(key, {
          token: metadata.as ?? target,
          factory: () => this.#autoConstruct(targetClass),
          scope: metadata.scope,
          dependencies: [],
        })
      }
    }
  }

  // ─── Internal resolution ──────────────────────────────────

  #resolveInner<T>(key: string, token: ServiceToken, runtimeValues?: unknown[]): T {
    // 1. Check swaps (test overrides)
    if (this.#overrides.has(key)) {
      // biome-ignore lint/suspicious/noExplicitAny: IoC container factory returns unknown; caller brands via T
      return this.#overrides.get(key)?.() as any as T
    }

    // 2. Check cached singletons
    if (this.#singletons.has(key)) {
      // biome-ignore lint/suspicious/noExplicitAny: IoC singleton stored as unknown; caller brands via T
      return this.#singletons.get(key) as any as T
    }

    // 3. Check explicit bindings
    const binding = this.#bindings.get(key)
    if (binding) {
      const instance = binding.factory ? binding.factory() : undefined
      if (binding.scope === 'singleton') {
        this.#singletons.set(key, instance)
      }
      this.#runResolvingHooks(key, instance)
      // Boundary cast from `unknown` — the caller brands the resolved type via T.
      return instance as T
    }

    // 4. Auto-construct if it's a class
    if (typeof token === 'function') {
      const instance = this.#autoConstruct(token, runtimeValues) as T
      this.#runResolvingHooks(key, instance)
      return instance
    }

    // 5. Not found
    const allKeys = [...this.#bindings.keys(), ...this.#overrides.keys()]
    const suggestion = didYouMean(key, allKeys)
    throw new ReamError(
      'CONTAINER_NOT_FOUND',
      `No binding found for '${key}'.${suggestion ? ` ${suggestion}` : ''}`,
      {
        hint: 'Register it with container.singleton() or decorate with @inject().',
      },
    )
  }

  /**
   * Auto-construct a class by reading its dependency hints.
   *
   * Resolution order (like AdonisJS Fold):
   * 1. static containerInjections._constructor.dependencies — explicit deps array
   * 2. Reflect.getMetadata('design:paramtypes') — decorator metadata (requires SWC/tsc)
   * 3. No params → plain `new Class()`
   */
  #autoConstruct(target: new (...args: unknown[]) => unknown, runtimeValues?: unknown[]): unknown {
    const metadata = getServiceMetadata(target)
    const scope = metadata?.scope ?? 'transient'
    const key = metadata?.as ?? target.name

    if (scope === 'singleton' && this.#singletons.has(key)) {
      return this.#singletons.get(key)
    }

    // A runtime value at this index (from `make(Class, [req, res])`) wins over
    // container resolution for that constructor slot.
    const runtimeAt = (index: number): unknown => runtimeValues?.[index]

    // 1. Check static containerInjections (AdonisJS Fold-compatible, works
    // without emitDecoratorMetadata). The `in` operator narrows the optional
    // field to `unknown`, then `readContainerInjectionDeps` validates the
    // shape at runtime — no type-level cast required.
    const explicitDeps = readContainerInjectionDeps(target)

    // 2. Fallback to reflect-metadata
    const paramTypes: unknown[] =
      explicitDeps ?? Reflect.getMetadata('design:paramtypes', target) ?? []

    const injectTokens = getInjectTokens(target)
    const lazyIndices = getLazyParams(target)

    // No `design:paramtypes` (a dev transpiler may not emit decorator metadata —
    // esbuild / tsx don't). Recover what we can, and NEVER construct with
    // silently-undefined deps (that masked a whole DI outage in dev):
    if (paramTypes.length === 0) {
      // (a) `@Inject(token)` records its tokens INDEPENDENTLY of decorator
      //     metadata, so even without `design:paramtypes` we can resolve the
      //     constructor from that map alone.
      if (injectTokens.size > 0) {
        const maxIndex = Math.max(...injectTokens.keys(), (runtimeValues?.length ?? 0) - 1)
        const deps = Array.from({ length: maxIndex + 1 }, (_value, index) => {
          const rt = runtimeAt(index)
          if (rt !== undefined) return rt
          const depToken = injectTokens.get(index)
          if (!depToken) return undefined
          if (lazyIndices.includes(index)) {
            return createLazyProxy(() => this.resolve<object>(depToken))
          }
          return this.resolve(depToken)
        })
        const instance = new target(...deps)
        if (scope === 'singleton') this.#singletons.set(key, instance)
        return instance
      }
      // (b) No @Inject/metadata, but the caller supplied runtime values — build
      //     from those (the `make(Controller, [req, res])` pattern with a plain
      //     constructor). Slots beyond the runtime values stay undefined.
      if (target.length > 0 && (runtimeValues?.length ?? 0) > 0) {
        const deps = Array.from({ length: target.length }, (_value, index) => runtimeAt(index))
        const instance = new target(...deps)
        if (scope === 'singleton') this.#singletons.set(key, instance)
        return instance
      }
      // (c) The constructor declares parameters but we have no way to resolve
      //     them (no metadata, no @Inject, no containerInjections). Fail LOUDLY
      //     instead of `new target()` with undefined deps.
      if (target.length > 0) {
        throw new ReamError(
          'CONTAINER_MISSING_METADATA',
          `Cannot auto-construct ${target.name}: it declares ${target.length} constructor parameter(s) but no dependency metadata was found.`,
          {
            hint: 'Enable decorator metadata (swc/tsc emitDecoratorMetadata), annotate constructor params with @Inject(token), or declare static containerInjections.',
          },
        )
      }
      // (c) Genuine zero-argument class.
      const instance = new target()
      if (scope === 'singleton') this.#singletons.set(key, instance)
      return instance
    }

    const deps = paramTypes.map((type, index) => {
      const rt = runtimeAt(index)
      if (rt !== undefined) return rt
      const namedToken = injectTokens.get(index)
      // A native primitive constructor (String/Number/Boolean/Array/Object/…)
      // is NOT injectable — emitDecoratorMetadata uses them for primitive/any
      // params. Treat them like `Object` (→ undefined, so a default value can
      // kick in) instead of trying to auto-construct `String`, which produced a
      // confusing "declares 1 constructor parameter" error.
      const depToken: ServiceToken | undefined =
        namedToken ?? (isInjectableClass(type) ? type : undefined)

      if (!depToken) return undefined

      if (lazyIndices.includes(index)) {
        // biome-ignore lint/suspicious/noExplicitAny: lazy proxy target must be object; IoC resolution returns unknown
        return createLazyProxy(() => this.resolve(depToken) as any as object)
      }

      return this.resolve(depToken)
    })

    const instance = new target(...deps)
    if (scope === 'singleton') this.#singletons.set(key, instance)
    return instance
  }

  #tokenToKey(token: ServiceToken): string {
    if (typeof token === 'string') {
      this.#assertNotReserved(token, 'string')
      return token
    }
    if (typeof token === 'symbol') {
      // Reject unique `Symbol(x)` — two `Symbol("foo")` calls create distinct
      // symbols, so an override registered with one would be invisible to a
      // resolver holding the other. Force callers onto `Symbol.for(x)` which
      // is the global registry and round-trips across modules.
      if (Symbol.keyFor(token) === undefined) {
        throw new ReamError(
          'CONTAINER_INVALID_TOKEN',
          `Unique Symbol() tokens are not supported — use Symbol.for("${token.description ?? 'name'}") so different modules see the same symbol.`,
        )
      }
      const desc = token.description
      if (desc === undefined) {
        throw new ReamError('CONTAINER_INVALID_TOKEN', 'Symbol tokens must have a description.')
      }
      this.#assertNotReserved(desc, 'symbol description')
      return `Symbol(${desc})`
    }
    return token.name
  }

  #assertNotReserved(name: string, kind: 'string' | 'symbol description'): void {
    if (RESERVED_TOKEN_NAMES.has(name)) {
      throw new ReamError('CONTAINER_RESERVED_TOKEN', `Reserved container token name '${name}'.`, {
        hint: `'${name}' would collide with an Object.prototype key. Pick a different ${kind}.`,
      })
    }
  }
}

/**
 * Native constructors emitDecoratorMetadata uses for primitive / `any` /
 * `unknown` parameters. They are NOT injectable — resolving them would try to
 * auto-construct `String`/`Number`/… (or silently inject `undefined`), so we
 * skip them and let a constructor default fill the slot instead.
 */
const NON_INJECTABLE_CONSTRUCTORS = new Set<unknown>([
  Object,
  String,
  Number,
  Boolean,
  Array,
  Function,
  Symbol,
  Date,
  RegExp,
  Promise,
  Error,
])

/** True for a real, injectable class token (excludes native primitive constructors). */
function isInjectableClass(value: unknown): value is new (...args: unknown[]) => unknown {
  return typeof value === 'function' && !NON_INJECTABLE_CONSTRUCTORS.has(value)
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

/**
 * Read `static containerInjections._constructor.dependencies` from a class,
 * AdonisJS Fold-style, when the static is present. The static is undeclared
 * on the constructor signature, so we walk the shape with `in`-narrowing
 * (TS 4.9+) plus a per-element `isServiceToken` guard — no casts.
 */
function readContainerInjectionDeps(target: object): ServiceToken[] | undefined {
  if (!('containerInjections' in target)) return undefined
  const injections = target.containerInjections
  if (typeof injections !== 'object' || injections === null) return undefined
  if (!('_constructor' in injections)) return undefined
  const ctor = injections._constructor
  if (typeof ctor !== 'object' || ctor === null) return undefined
  if (!('dependencies' in ctor)) return undefined
  const deps = ctor.dependencies
  if (!Array.isArray(deps)) return undefined
  return deps.every(isServiceToken) ? deps : undefined
}

function isServiceToken(value: unknown): value is ServiceToken {
  return typeof value === 'string' || typeof value === 'symbol' || typeof value === 'function'
}

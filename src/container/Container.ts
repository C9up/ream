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
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  getInjectTokens,
  getMethodInjectTokens,
  getServiceMetadata,
  getServiceRegistry,
} from '../decorators/Service.js'
import { didYouMean } from '../errors/FuzzyMatcher.js'
import { ReamError } from '../errors/ReamError.js'
import { ContainerResolver } from './ContainerResolver.js'
import { ContextualBindingsBuilder } from './ContextualBindingsBuilder.js'
import type { Binding, ServiceFactory, ServiceToken } from './types.js'

/**
 * Symbol descriptions that would collide with object-prototype keys if used
 * as raw map keys. We reject them on registration so tokens cannot be used
 * as a prototype-pollution vector.
 */
const RESERVED_TOKEN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** One resolution chain: the tokens on it, and a set for O(1) membership. */
interface ResolutionChain {
  stack: string[]
  set: Set<string>
  /**
   * Values bound on the {@link ContainerResolver} that opened this chain.
   *
   * Carried on the chain, not passed down each private method, so a value
   * bound for one request is visible to everything that resolution triggers —
   * a controller's constructor dependency sees the same `HttpContext` the
   * middleware bound — and to nothing outside it.
   */
  values?: ReadonlyMap<string, unknown>
  /**
   * How many scoped values this chain has handed out so far.
   *
   * A singleton built while a request's values are in scope may have captured
   * one — cache it app-wide and every later request gets the first request's
   * `HttpContext`. Comparing this counter before and after a build says whether
   * it actually read one, so a singleton that touched no request state still
   * caches exactly as before.
   */
  scopedReads?: number
  /**
   * The class whose dependencies are being resolved right now.
   *
   * A contextual binding answers "when THIS class asks for that, give it
   * this", so the lookup needs the direct dependent. Carried on the chain for
   * the same reason the scoped values are: `#autoConstruct` knows it, and
   * every method between there and the lookup would otherwise have to pass it
   * down. Saved and restored around each construction, so a dependency's own
   * dependencies see IT as their parent, not its parent.
   */
  parent?: new (
    ...args: never[]
  ) => unknown
}

export class Container {
  #bindings: Map<string, Binding> = new Map()
  #singletons: Map<string, unknown> = new Map()
  /**
   * Singletons currently being built, by key.
   *
   * The factory is async, so two resolves at cold start both get past the
   * cache check and both run it — producing two instances where the whole
   * point is one, and silently discarding the first (a second connection
   * pool, a second scheduler). Concurrent callers await the same promise.
   */
  #pendingSingletons: Map<string, Promise<unknown>> = new Map()
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
  /** parent class → (binding key → the factory that class gets instead). */
  #contextualBindings: Map<new (...args: never[]) => unknown, Map<string, ServiceFactory>> =
    new Map()
  /** token key → post-resolution callbacks (AdonisJS `container.resolving`). */
  #resolvingHooks: Map<string, Array<(value: unknown) => void | Promise<void>>> = new Map()
  /**
   * The resolution chain currently being walked, for cycle detection.
   *
   * Scoped to the async context, NOT to the container: `resolve()` is async, so
   * two independent chains interleave, and a stack held on the instance would
   * splice them together and report a cycle neither of them has. Per-container
   * storage keeps a chain that crosses two containers from colliding on a token
   * name they happen to share.
   */
  readonly #chain = new AsyncLocalStorage<ResolutionChain>()

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
   * Give ONE class a different implementation of a dependency (AdonisJS
   * `container.contextualBinding`).
   *
   * `contextualBinding(UsersController, Hash, () => new Argon2())` — everyone
   * else asking for `Hash` still gets the container's binding. See
   * {@link when} for the fluent spelling.
   */
  contextualBinding(
    parent: new (...args: never[]) => unknown,
    binding: ServiceToken,
    factory: ServiceFactory,
  ): void {
    const forParent = this.#contextualBindings.get(parent) ?? new Map()
    forParent.set(this.#tokenToKey(binding), factory)
    this.#contextualBindings.set(parent, forParent)
  }

  /**
   * Fluent contextual binding (AdonisJS `container.when`):
   *
   *     container.when(UsersController).asksFor(Hash).provide(() => new Argon2())
   */
  when(parent: new (...args: never[]) => unknown): ContextualBindingsBuilder {
    return new ContextualBindingsBuilder(this, parent)
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
  resolving(token: ServiceToken, callback: (value: unknown) => void | Promise<void>): void {
    const key = this.#tokenToKey(token)
    const hooks = this.#resolvingHooks.get(key)
    if (hooks) hooks.push(callback)
    else this.#resolvingHooks.set(key, [callback])
  }

  async #runResolvingHooks(key: string, value: unknown): Promise<void> {
    const hooks = this.#resolvingHooks.get(key)
    if (hooks) for (const hook of hooks) await hook(value)
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

  /**
   * Undo swaps in bulk (AdonisJS `restoreAll`).
   *
   * With no argument it restores everything — the same thing `restore()` does
   * bare. Pass a list to undo only those, which is what a test does when it
   * wants one swap to outlive the others.
   */
  restoreAll(tokens?: ServiceToken[]): void {
    if (!tokens) {
      this.restore()
      return
    }
    for (const token of tokens) {
      this.#restoreOne(this.#tokenToKey(token))
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
  make<T>(token: ServiceToken, runtimeValues?: unknown[]): Promise<T> {
    return this.resolve<T>(token, runtimeValues)
  }

  /**
   * Resolve/construct a class or binding (AdonisJS `container.make` — async, so
   * factories, providers and `resolving` hooks may be async). `runtimeValues`
   * fill the resolved class's constructor slots by index (`make(Class, [req,
   * res])`); only the `undefined` slots are container-resolved, top-level only.
   */
  async resolve<T>(token: ServiceToken, runtimeValues?: unknown[]): Promise<T> {
    // Dereference aliases to the final target before anything else. Walked in
    // a LOOP with its own seen-set: recursing into `resolve()` re-entered
    // before the cycle guard below was armed, so `alias('a','b')` +
    // `alias('b','a')` overflowed the stack instead of naming the cycle.
    let resolvedToken = token
    let key = this.#tokenToKey(resolvedToken)
    const seenAliases = new Set<string>([key])
    for (
      let target = this.#aliases.get(key);
      target !== undefined;
      target = this.#aliases.get(key)
    ) {
      resolvedToken = target
      key = this.#tokenToKey(target)
      if (seenAliases.has(key)) {
        const cycle = [...seenAliases, key].join(' → ')
        throw new ReamError('E_CIRCULAR_DEPENDENCY', `Circular alias detected: ${cycle}`, {
          hint: 'An alias chain must end at a real binding — remove one of the aliases.',
          context: { chain: cycle },
        })
      }
      seenAliases.add(key)
    }
    token = resolvedToken

    // Top of a chain: open one, so everything this resolution triggers shares
    // it and nothing outside it does.
    const chain = this.#chain.getStore()
    if (chain === undefined) {
      return this.#chain.run({ stack: [], set: new Set() }, () =>
        this.resolve<T>(token, runtimeValues),
      )
    }

    if (chain.set.has(key)) {
      const cycle = [...chain.stack, key].join(' → ')
      throw new ReamError('E_CIRCULAR_DEPENDENCY', `Circular dependency detected: ${cycle}`, {
        hint: 'Break the cycle by resolving one dependency lazily inside a method (`await container.make(Dep)`) instead of injecting it in the constructor.',
        context: { chain: cycle },
      })
    }
    chain.stack.push(key)
    chain.set.add(key)

    try {
      return await this.#resolveInner<T>(key, token, runtimeValues)
    } finally {
      chain.stack.pop()
      chain.set.delete(key)
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
    type Ctor = new (...args: never[]) => unknown
    // `Object.getPrototypeOf` is typed `any` in lib.dom, so the assignment
    // narrows it back to a typed constructor without a cast expression.
    const target: Ctor = Object.getPrototypeOf(instance).constructor
    // A method's dependencies are dependencies of the class declaring it, so a
    // contextual binding applies to `call()` exactly as to a constructor. There
    // is usually no chain open here — `call()` is an entry point — so one is
    // opened to carry the parent, rather than each `resolve()` below opening
    // its own with nobody in it.
    const chain = this.#chain.getStore()
    if (chain === undefined) {
      return this.#chain.run({ stack: [], set: new Set(), parent: target }, () =>
        this.call(instance, method, runtimeValues),
      )
    }
    const outerParent = chain.parent
    chain.parent = target
    const paramTypes: unknown[] =
      Reflect.getMetadata('design:paramtypes', target.prototype, method) ?? []
    // `@Inject('token')` on a method parameter — a named binding the reflected
    // type cannot express (an interface, or a class registered under a name).
    const injectTokens = getMethodInjectTokens(target.prototype, method)

    // `@Inject` counts towards the parameter span too: a method may carry named
    // tokens without `design:paramtypes` being emitted for it, and computing the
    // span from the reflected types alone left the loop at zero iterations —
    // the tokens were read and then never used.
    const injectSpan = injectTokens.size === 0 ? 0 : Math.max(...injectTokens.keys()) + 1
    const len = Math.max(paramTypes.length, runtimeValues?.length ?? 0, injectSpan)
    // Sequential resolution keeps the shared cycle-detection stack consistent.
    const args: unknown[] = []
    for (let index = 0; index < len; index += 1) {
      // Runtime values take precedence (and fill slots beyond paramTypes).
      if (runtimeValues && index < runtimeValues.length) {
        args.push(runtimeValues[index])
        continue
      }
      const named = injectTokens.get(index)
      if (named !== undefined) {
        args.push(await this.resolve(named))
        continue
      }
      const type = paramTypes[index]
      args.push(isInjectableClass(type) ? await this.resolve(type) : undefined)
    }

    chain.parent = outerParent

    const member: unknown = instance[method]
    if (!isCallable(member)) {
      throw new Error(`Container.call: '${method}' is not a callable method`)
    }
    return member.apply(instance, args)
  }

  /**
   * A resolver whose {@link ContainerResolver.bindValue} values are isolated
   * from this container (AdonisJS `container.createResolver()`).
   *
   * Anything the resolver builds — and everything that build depends on — sees
   * those values; nothing outside it does. This is how a request binds its own
   * `HttpContext` without every other request seeing it.
   */
  createResolver(): ContainerResolver {
    return new ContainerResolver(this)
  }

  /**
   * @internal Run `fn` with `values` layered onto the resolution chain.
   *
   * Reuses an open chain rather than starting a second one, so cycle detection
   * still spans the whole resolution when a resolver is used inside a factory.
   */
  runWithScopedValues<T>(values: ReadonlyMap<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const chain = this.#chain.getStore()
    return this.#chain.run(
      chain === undefined ? { stack: [], set: new Set(), values } : { ...chain, values },
      fn,
    )
  }

  /** @internal Normalise a token the way the container keys it. */
  keyFor(token: ServiceToken): string {
    return this.#tokenToKey(token)
  }

  /**
   * Resolve `token` as if `parent` had asked for it, so `parent`'s contextual
   * bindings apply (AdonisJS `resolveFor`). `parent: null` means nobody asked —
   * identical to {@link make}.
   */
  async resolveFor<T>(
    parent: (new (...args: never[]) => unknown) | null,
    token: ServiceToken,
    runtimeValues?: unknown[],
  ): Promise<T> {
    if (parent === null) return this.make<T>(token, runtimeValues)
    const chain = this.#chain.getStore()
    return this.#chain.run(
      chain === undefined ? { stack: [], set: new Set(), parent } : { ...chain, parent },
      () => this.make<T>(token, runtimeValues),
    )
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

  /**
   * True when the token was bound EXPLICITLY (AdonisJS `hasBinding`).
   *
   * Narrower than {@link has} on purpose, and this is the AdonisJS meaning:
   * `has` answers "can this be resolved", which is also true for an alias or
   * for a class carrying `@Service` that nobody registered. `hasBinding`
   * answers "did someone register this", which is what a provider asks before
   * deciding whether to register a default.
   */
  hasBinding(token: ServiceToken): boolean {
    const key = this.#tokenToKey(token)
    return this.#bindings.has(key) || this.#overrides.has(key) || this.#singletons.has(key)
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

  async #resolveInner<T>(key: string, token: ServiceToken, runtimeValues?: unknown[]): Promise<T> {
    // 1. Check swaps (test overrides) — a swap factory may be async.
    if (this.#overrides.has(key)) {
      const swapped = await this.#overrides.get(key)?.(this)
      return swapped as T
    }

    // 2. A contextual binding for the class currently being built — "when
    //    UsersController asks for Hash, give it Argon2". Before the resolver's
    //    values and the container's, after swaps: @adonisjs/fold's order.
    const store = this.#chain.getStore()
    const contextual =
      store?.parent === undefined ? undefined : this.#contextualBindings.get(store.parent)?.get(key)
    if (contextual !== undefined) {
      const instance = await contextual(this)
      await this.#runResolvingHooks(key, instance)
      return instance as T
    }

    // 3. A value bound on the resolver that opened this chain. Before the
    //    container's own values, after swaps — the order @adonisjs/fold
    //    resolves in (`resolveFor`: swaps, resolver values, container values).
    //    No `resolving` hooks: the value was not constructed here.
    if (store?.values?.has(key)) {
      store.scopedReads = (store.scopedReads ?? 0) + 1
      return store.values.get(key) as T
    }

    // 4. Check cached singletons
    if (this.#singletons.has(key)) {
      return this.#singletons.get(key) as T
    }

    // 5. Check explicit bindings — the factory may be async.
    const binding = this.#bindings.get(key)
    if (binding) {
      if (binding.scope !== 'singleton') {
        const instance = binding.factory ? await binding.factory(this) : undefined
        await this.#runResolvingHooks(key, instance)
        // Boundary cast from `unknown` — the caller brands the resolved type via T.
        return instance as T
      }

      // A build already under way: join it rather than start a second one.
      const inFlight = this.#pendingSingletons.get(key)
      if (inFlight) return (await inFlight) as T

      const readsBefore = store?.scopedReads ?? 0
      const building = (async (): Promise<unknown> => {
        const instance = binding.factory ? await binding.factory(this) : undefined
        // See `ResolutionChain.scopedReads`: a build that consumed a
        // request-scoped value is that request's, not the application's.
        this.#cacheIfAppWide('singleton', key, instance, store, readsBefore)
        // Inside the promise, so the hooks run exactly once per instance no
        // matter how many callers were waiting.
        await this.#runResolvingHooks(key, instance)
        return instance
      })()
      this.#pendingSingletons.set(key, building)
      try {
        return (await building) as T
      } finally {
        // Cleared either way: a failed build must not poison later attempts.
        this.#pendingSingletons.delete(key)
      }
    }

    // 6. Auto-construct if it's a class
    if (typeof token === 'function') {
      const instance = (await this.#autoConstruct(token, runtimeValues)) as T
      await this.#runResolvingHooks(key, instance)
      return instance
    }

    // 7. Not found
    const allKeys = [...this.#bindings.keys(), ...this.#overrides.keys()]
    const suggestion = didYouMean(key, allKeys)
    throw new ReamError(
      'E_CONTAINER_NOT_FOUND',
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
  async #autoConstruct(
    target: new (...args: never[]) => unknown,
    runtimeValues?: unknown[],
  ): Promise<unknown> {
    // Everything resolved inside is a dependency OF `target`, which is what a
    // contextual binding keys on. Restored on EVERY exit — the construction has
    // three returns and can throw — so `target`'s own parent is back in place.
    const store = this.#chain.getStore()
    const outerParent = store?.parent
    if (store !== undefined) store.parent = target
    try {
      return await this.#constructWithDeps(target, runtimeValues)
    } finally {
      if (store !== undefined) store.parent = outerParent
    }
  }

  async #constructWithDeps(
    target: new (...args: never[]) => unknown,
    runtimeValues?: unknown[],
  ): Promise<unknown> {
    const metadata = getServiceMetadata(target)
    const scope = metadata?.scope ?? 'transient'
    const key = metadata?.as ?? target.name

    if (scope === 'singleton' && this.#singletons.has(key)) {
      return this.#singletons.get(key)
    }

    // Same rule as the explicit singleton bindings: see `scopedReads`.
    const store = this.#chain.getStore()
    const readsBefore = store?.scopedReads ?? 0

    // A runtime value at this index (from `make(Class, [req, res])`) wins over
    // container resolution for that constructor slot.
    const runtimeAt = (index: number): unknown => runtimeValues?.[index]

    // 1. Check static containerInjections (AdonisJS Fold-compatible, works
    // without emitDecoratorMetadata).
    const explicitDeps = readContainerInjectionDeps(target)

    // 2. Fallback to reflect-metadata
    const paramTypes: unknown[] =
      explicitDeps ?? Reflect.getMetadata('design:paramtypes', target) ?? []

    const injectTokens = getInjectTokens(target)

    // No `design:paramtypes` (a dev transpiler may not emit decorator metadata —
    // esbuild / tsx don't). Recover what we can, and NEVER construct with
    // silently-undefined deps (that masked a whole DI outage in dev):
    if (paramTypes.length === 0) {
      // (a) `@Inject(token)` records its tokens INDEPENDENTLY of decorator
      //     metadata, so even without `design:paramtypes` we can resolve the
      //     constructor from that map alone. Deps resolve SEQUENTIALLY so the
      //     shared cycle-detection stack stays consistent.
      if (injectTokens.size > 0) {
        const maxIndex = Math.max(...injectTokens.keys(), (runtimeValues?.length ?? 0) - 1)
        const deps: unknown[] = []
        for (let index = 0; index <= maxIndex; index += 1) {
          const rt = runtimeAt(index)
          if (rt !== undefined) {
            deps.push(rt)
            continue
          }
          const depToken = injectTokens.get(index)
          deps.push(depToken ? await this.resolve(depToken) : undefined)
        }
        const instance = Reflect.construct(target, deps)
        this.#cacheIfAppWide(scope, key, instance, store, readsBefore)
        return instance
      }
      // (b) No @Inject/metadata, but the caller supplied runtime values — build
      //     from those (the `make(Controller, [req, res])` pattern with a plain
      //     constructor). Slots beyond the runtime values stay undefined.
      if (target.length > 0 && (runtimeValues?.length ?? 0) > 0) {
        const deps = Array.from({ length: target.length }, (_value, index) => runtimeAt(index))
        const instance = Reflect.construct(target, deps)
        this.#cacheIfAppWide(scope, key, instance, store, readsBefore)
        return instance
      }
      // (c) The constructor declares parameters but we have no way to resolve
      //     them (no metadata, no @Inject, no containerInjections). Fail LOUDLY
      //     instead of `new target()` with undefined deps.
      if (target.length > 0) {
        throw new ReamError(
          'E_CONTAINER_MISSING_METADATA',
          `Cannot auto-construct ${target.name}: it declares ${target.length} constructor parameter(s) but no dependency metadata was found.`,
          {
            hint: 'Enable decorator metadata (swc/tsc emitDecoratorMetadata), annotate constructor params with @Inject(token), or declare static containerInjections.',
          },
        )
      }
      // (d) Genuine zero-argument class.
      const instance = new target()
      this.#cacheIfAppWide(scope, key, instance, store, readsBefore)
      return instance
    }

    // Resolve constructor deps SEQUENTIALLY (the cycle-detection stack is
    // instance-shared, so parallel Promise.all would interleave and corrupt it).
    const deps: unknown[] = []
    for (let index = 0; index < paramTypes.length; index += 1) {
      const rt = runtimeAt(index)
      if (rt !== undefined) {
        deps.push(rt)
        continue
      }
      const namedToken = injectTokens.get(index)
      const type = paramTypes[index]
      // A native primitive constructor (String/Number/Boolean/…) is NOT
      // injectable — leave the slot undefined so a constructor default can fill it.
      const depToken: ServiceToken | undefined =
        namedToken ?? (isInjectableClass(type) ? type : undefined)
      deps.push(depToken ? await this.resolve(depToken) : undefined)
    }

    const instance = Reflect.construct(target, deps)
    this.#cacheIfAppWide(scope, key, instance, store, readsBefore)
    return instance
  }

  /**
   * Cache a singleton — unless it read a request-scoped value while building.
   *
   * See `ResolutionChain.scopedReads`: an instance that captured one belongs to
   * that request, and caching it hands the first request's state to every
   * later one. AdonisJS does not guard this; it is the kind of silent
   * cross-request leak worth refusing.
   */
  #cacheIfAppWide(
    scope: string,
    key: string,
    instance: unknown,
    store: ResolutionChain | undefined,
    readsBefore: number,
  ): void {
    if (scope !== 'singleton') return
    if ((store?.scopedReads ?? 0) !== readsBefore) return
    this.#singletons.set(key, instance)
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
          'E_CONTAINER_INVALID_TOKEN',
          `Unique Symbol() tokens are not supported — use Symbol.for("${token.description ?? 'name'}") so different modules see the same symbol.`,
        )
      }
      const desc = token.description
      if (desc === undefined) {
        throw new ReamError('E_CONTAINER_INVALID_TOKEN', 'Symbol tokens must have a description.')
      }
      this.#assertNotReserved(desc, 'symbol description')
      return `Symbol(${desc})`
    }
    return token.name
  }

  #assertNotReserved(name: string, kind: 'string' | 'symbol description'): void {
    if (RESERVED_TOKEN_NAMES.has(name)) {
      throw new ReamError(
        'E_CONTAINER_RESERVED_TOKEN',
        `Reserved container token name '${name}'.`,
        {
          hint: `'${name}' would collide with an Object.prototype key. Pick a different ${kind}.`,
        },
      )
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
function isInjectableClass(value: unknown): value is new (...args: never[]) => unknown {
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

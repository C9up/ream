/**
 * Unified Middleware Pipeline — typed for HttpContext.
 *
 * @implements FR22, FR27
 *
 * Pipeline order (fixed):
 * 1. Global middleware, then the router stack (`router.use()`)
 * 2. Route/handler named middleware
 * 3. Route inline middleware
 * 4. Guard (auth + roles + permissions)
 * 5. Handler
 */

import { debugHttp } from '../debug.js'
import {
  E_MIDDLEWARE_NOT_FOUND,
  E_PIPELINE_DOUBLE_NEXT,
  E_VALIDATOR_UNUSABLE,
} from '../errors/codes.js'
import {
  E_AUTHORIZATION_FAILURE,
  E_UNAUTHORIZED_ACCESS,
  E_VALIDATION_ERROR,
  E_WARDEN_MFA_REQUIRED,
} from '../http/Exception.js'
import type { HttpContext } from '../http/HttpContext.js'
import { authenticatedByGuardLevels, holdsPermissions, holdsRoles } from '../http/permissions.js'

export type MiddlewareFunction = (
  ctx: HttpContext,
  next: () => Promise<void>,
) => Promise<void> | void

/** What a route validator must hand back, whichever method it exposes. */
export interface RuntimeValidationResult {
  valid: boolean
  errors: unknown[]
  data?: unknown
}

/**
 * Structural contract for a route validator. ream stays decoupled from the
 * validation engine — any object exposing a result-returning check works.
 *
 * Three spellings are accepted because `@c9up/rune` offers all three: `validate()`
 * is async and throws, `validateResult()` is synchronous and never throws, and
 * `validateResultAsync()` is the async result-based form.
 *
 * `validateResultAsync` is preferred. The synchronous `validateResult()` cannot
 * run async rules — with `unique`, `exists` or `useAsync` in the schema it
 * throws a plain Error, which would surface as a 500 instead of a 422.
 */
export interface RuntimeValidator {
  validate?(data: unknown): RuntimeValidationResult | Promise<unknown>
  validateResult?(data: unknown): RuntimeValidationResult
  validateResultAsync?(data: unknown): Promise<RuntimeValidationResult>
}

/** A thrown validation failure, as raised by rune's `validate()`. */
interface ThrownValidationFailure {
  messages: unknown[]
}

function isThrownValidationFailure(value: unknown): value is ThrownValidationFailure {
  return (
    value instanceof Error && 'messages' in value && Array.isArray(Reflect.get(value, 'messages'))
  )
}

function isValidationResult(value: unknown): value is RuntimeValidationResult {
  return typeof value === 'object' && value !== null && 'valid' in value
}

/**
 * Run a validator whatever contract it exposes, and always come back with a
 * result object.
 *
 * Order matters: the async result form first (it is the only one that can run
 * `unique` / `exists`), then the synchronous one, then the throwing
 * `validate()` — awaited, and with its `E_VALIDATION_ERROR` translated back
 * into a result so callers keep a single shape to handle.
 */
export async function runValidator(
  validator: RuntimeValidator,
  data: unknown,
): Promise<RuntimeValidationResult> {
  if (typeof validator.validateResultAsync === 'function') {
    return validator.validateResultAsync(data)
  }

  if (typeof validator.validateResult === 'function') {
    return validator.validateResult(data)
  }

  if (typeof validator.validate === 'function') {
    try {
      const outcome = await validator.validate(data)
      // A result-returning `validate()` (not the throwing contract) is honoured
      // as-is; the throwing contract resolves to the validated payload.
      return isValidationResult(outcome) ? outcome : { valid: true, errors: [], data: outcome }
    } catch (err) {
      if (isThrownValidationFailure(err)) {
        return { valid: false, errors: err.messages }
      }
      throw err
    }
  }

  // A dedicated code, not a TypeError: callers tell this configuration
  // mistake apart from a TypeError raised by a bug inside a rule.
  throw new E_VALIDATOR_UNUSABLE()
}

/**
 * Another place named middleware are declared: the router's `named()`
 * collection, which is where an application declares them.
 */
export interface NamedMiddlewareSource {
  getNamedMiddleware(name: string): MiddlewareFunction | undefined
  getNamedMiddlewareNames(): string[]
}

/**
 * Named middleware registry.
 *
 * A name resolves to what `register()` put here first, then to the
 * `source` given to the constructor — the application's registry is built
 * over its router, so `route.middleware('auth')`, an RPC method's and a
 * GraphQL resolver's `middleware: ['auth']` all find what
 * `router.named({ auth })` declared.
 */
export class MiddlewareRegistry {
  #global: MiddlewareFunction[] = []
  #named: Map<string, MiddlewareFunction> = new Map()
  readonly #source: NamedMiddlewareSource | undefined

  constructor(source?: NamedMiddlewareSource) {
    this.#source = source
  }

  /** Register a global middleware (runs on every request). */
  use(middleware: MiddlewareFunction): void {
    this.#global.push(middleware)
  }

  /** Register a named middleware. */
  register(name: string, middleware: MiddlewareFunction): void {
    this.#named.set(name, middleware)
  }

  /** Get a named middleware: a registered one, else the source's. */
  get(name: string): MiddlewareFunction | undefined {
    return this.#named.get(name) ?? this.#source?.getNamedMiddleware(name)
  }

  /** Every name {@link get} resolves, the registered ones first. */
  names(): string[] {
    return [...new Set([...this.#named.keys(), ...(this.#source?.getNamedMiddlewareNames() ?? [])])]
  }

  /** Get all global middleware. */
  getGlobal(): MiddlewareFunction[] {
    return [...this.#global]
  }

  /** Build the execution chain for a request. */
  buildChain(
    namedMiddleware: string[],
    inlineMiddleware: MiddlewareFunction[],
    handler: MiddlewareFunction,
    options?: {
      /** Guard levels: one guard every list accepts (see `authenticatedByGuardLevels`). */
      guards?: string[][]
      /** Role requirements: one role of EACH list (see `holdsRoles`). */
      roles?: string[][]
      permissions?: string[]
      /**
       * The action carries `@RequireMfa()`: the request must be authenticated
       * and its credential must have completed the MFA step-up
       * (`ctx.auth.user.mfa === true`).
       */
      mfa?: boolean
      validators?: RuntimeValidator[]
      /** Turns an error into a response where it is thrown, see {@link composeMiddleware}. */
      onError?: MiddlewareErrorHandler
      /**
       * Further named middleware, looked up after this registry's own: the
       * kernel passes its router, whose `named()` collection is where an
       * application declares them.
       */
      named?: NamedMiddlewareSource
      /**
       * The router stack (`router.use()`). It runs ahead of the route's own
       * middleware, named ones included, as upstream's route puts the router
       * middleware first in its stack: the session and silent auth it mounts
       * are what a named `auth` middleware reads.
       */
      routerMiddleware?: MiddlewareFunction[]
    },
  ): MiddlewareFunction {
    const extra = options?.named
    const stack: MiddlewareFunction[] = [
      // 1. Global middleware
      ...this.#global,
      // 1b. Router middleware
      ...(options?.routerMiddleware ?? []),
      // 2. Named middleware — an unknown name is a hard error, NOT a silent
      // skip: a typo'd `.middleware('auht')` must never run the route
      // unprotected with zero diagnostics.
      ...namedMiddleware.map((name) => {
        const mw = this.get(name) ?? extra?.getNamedMiddleware(name)
        if (mw === undefined) {
          const known = new Set([...this.names(), ...(extra?.getNamedMiddlewareNames() ?? [])])
          throw new E_MIDDLEWARE_NOT_FOUND([
            `Named middleware '${name}' is not registered. ` +
              `Registered: ${[...known].join(', ') || '(none)'}`,
          ])
        }
        return mw
      }),
      // 3. Inline middleware
      ...inlineMiddleware,
      // 4. Guard enforcement (throws exceptions instead of setting response)
      ...((options?.guards?.length ?? 0) > 0 ||
      (options?.roles?.length ?? 0) > 0 ||
      (options?.permissions?.length ?? 0) > 0 ||
      options?.mfa === true
        ? [
            createGuardMiddleware(
              options?.guards ?? [],
              options?.roles,
              options?.permissions,
              options?.mfa === true,
            ),
          ]
        : []),
      // 4b. Validation — runs AFTER auth (so unauthenticated requests 401 before
      // the body is inspected) and BEFORE the handler.
      ...((options?.validators?.length ?? 0) > 0
        ? [createValidationMiddleware(options?.validators ?? [])]
        : []),
      // 5. Handler
      handler,
    ]

    return composeMiddleware(stack, options?.onError)
  }
}

/**
 * What turns an error into a response inside the chain: the exception
 * handler, for the HTTP kernel. It must not throw.
 */
export type MiddlewareErrorHandler = (error: unknown, ctx: HttpContext) => Promise<void>

/**
 * Compose middleware into a single handler (onion pattern).
 *
 * NOT `compose` — that name means mixin composition in `helpers`, the way it
 * does in AdonisJS, and the two were one import away from each other on the
 * barrel.
 */
function composeMiddleware(
  middleware: MiddlewareFunction[],
  onError?: MiddlewareErrorHandler,
): MiddlewareFunction {
  return async (ctx: HttpContext, finalNext: () => Promise<void>) => {
    let index = -1

    // With `onError`, every layer runs under it, as upstream's middleware
    // runner does with an error handler: an error becomes a response at the
    // layer that threw, and the `next()` the outer layer awaits resolves. So
    // the code after `await next()` (the session commit, a header) runs for a
    // request that failed too, and an error's `handle()` that flashes reaches
    // the session store.
    const run = onError
      ? (i: number): Promise<void> => dispatch(i).catch((error: unknown) => onError(error, ctx))
      : dispatch

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new E_PIPELINE_DOUBLE_NEXT()
      }
      index = i

      const fn = i < middleware.length ? middleware[i] : finalNext
      if (!fn) return

      if (debugHttp.enabled && i < middleware.length) {
        // `fn.name` is what a named middleware function or a bound class
        // method carries; an inline arrow has none, and its position is the
        // only thing that identifies it.
        debugHttp('middleware %d/%d %s', i + 1, middleware.length, fn.name || '(anonymous)')
      }
      await fn(ctx, () => run(i + 1))
    }

    await run(0)
  }
}

/**
 * Guard enforcement middleware.
 * Throws `E_UNAUTHORIZED_ACCESS` (401), `E_AUTHORIZATION_FAILURE` (403) and
 * `E_WARDEN_MFA_REQUIRED` (403), the codes @c9up/warden raises for the same
 * refusals, in the order its middleware checks them: authentication, roles
 * and permissions, then the MFA step-up.
 */
function createGuardMiddleware(
  guards: string[][],
  roles?: string[][],
  permissions?: string[],
  mfa = false,
): MiddlewareFunction {
  return async (ctx, next) => {
    // Each guard level names who may vouch for the request, and the guard that
    // did must be in every level (see authenticatedByGuardLevels). A 401 from
    // the guards themselves propagates, with its redirect or challenge.
    if (guards.length > 0 && !(await authenticatedByGuardLevels(ctx.auth, guards))) {
      throw new E_UNAUTHORIZED_ACCESS()
    }
    // Roles, permissions and the MFA step-up say who may run the action,
    // which presupposes knowing who is asking: alone, without a guard, they
    // still require an authenticated request.
    const needsAuth = (roles && roles.length > 0) || (permissions && permissions.length > 0) || mfa
    if (needsAuth && !ctx.auth.isAuthenticated) {
      throw new E_UNAUTHORIZED_ACCESS()
    }

    // Every role requirement must be met: a group, a nested group or a
    // decorator adds a requirement and never widens the route's own.
    if (roles && roles.length > 0 && !holdsRoles(ctx.auth, roles)) {
      throw new E_AUTHORIZATION_FAILURE()
    }

    // A token-authenticated request also needs the token to allow each one.
    if (permissions && permissions.length > 0) {
      if (!(await holdsPermissions(ctx.auth, permissions))) {
        throw new E_AUTHORIZATION_FAILURE()
      }
    }

    // `user.mfa` is the claim the guard sets from the credential the request
    // came with. Strictly `true`: a truthy value some user payload happens to
    // carry is not a completed step-up.
    if (mfa && ctx.auth.user?.mfa !== true) {
      throw new E_WARDEN_MFA_REQUIRED()
    }

    await next()
  }
}

/**
 * Validation enforcement middleware. Runs each resolved route validator against
 * the request body; the first failure throws `E_VALIDATION_ERROR` (422). On
 * success the sanitized/coerced payload is stored on `request.validated()`.
 */
function createValidationMiddleware(validators: RuntimeValidator[]): MiddlewareFunction {
  return async (ctx, next) => {
    for (const validator of validators) {
      const result = await runValidator(validator, ctx.request.body())
      if (!result.valid) {
        throw new E_VALIDATION_ERROR(result.errors)
      }
      if (result.data !== undefined) {
        ctx.request.setValidated(result.data)
      }
    }
    await next()
  }
}

export { composeMiddleware }

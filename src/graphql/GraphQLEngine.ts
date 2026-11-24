/**
 * GraphQLEngine — schema-first GraphQL with Rust query validation.
 *
 * - Schema parsed from .graphql files at boot
 * - Queries validated by Rust before NAPI crossing (when available)
 * - Resolvers are IoC-injected controller-like classes
 * - @Guard/@Role enforced per TOP-LEVEL resolver field (nested fields are
 *   projected from the resolver's return value, not independently resolved —
 *   so they carry no per-field guard; don't return guarded data from an
 *   unguarded resolver and rely on a nested field guard to hide it).
 * - Every selection, at every depth, is checked against the schema before any
 *   resolver runs, and the response is read by the schema: of what a resolver
 *   returns, only the fields that are selected AND declared by the value's
 *   type go out. A field the schema does not declare cannot be selected, and
 *   an object cannot be asked for whole. What the schema declares is public
 *   to whoever may call the resolver: declare only what a client may read.
 * - Zero non-null assertions — types guaranteed by schema validation
 *
 * Usage:
 *   const engine = new GraphQLEngine({ schemaPath: './app/graphql/schema.graphql' })
 *   engine.resolver('Query', 'tasks', TaskResolver, 'tasks')
 *   engine.resolver('Mutation', 'createTask', TaskResolver, 'createTask', { guard: 'jwt', role: 'cs_member' })
 *
 * @implements MISS-28
 */

import * as fs from 'node:fs'
import { currentNodeEnv } from '../env/nodeEnv.js'
import {
  E_EMPTY_GATE_REQUIREMENT,
  E_GRAPHQL_SCHEMA_NOT_FOUND,
  E_MIDDLEWARE_NOT_FOUND,
} from '../errors/codes.js'
import { callNative, fromNativeError } from '../errors/native.js'
import { loadNapi } from '../helpers/napi-loader.js'
import type { HttpContext } from '../http/HttpContext.js'
import {
  authenticatedByGuards,
  holdsPermissions,
  isUnauthorizedError,
} from '../http/permissions.js'
import type { MiddlewareRegistry } from '../middleware/Pipeline.js'
import { composeMiddleware } from '../middleware/Pipeline.js'
import { safeJsonParse } from '../utils/safeJsonParse.js'
import {
  GraphQLSchema,
  isSchemaTypes,
  overlaps,
  type ProjectionContext,
  projectValue,
  type SchemaArg,
  type SchemaField,
  type TypeConditionLink,
  TypeConditions,
  type TypeResolver,
} from './schema.js'

/** Rust parser output (the `ream-graphql` crate via the `index` NAPI binary). */
interface RustParsedField {
  name: string
  alias: string | null
  args: Record<string, unknown>
  sub_fields: RustParsedField[]
  /** Index into `type_conditions`, for a field expanded from a fragment. */
  condition: number | null
}
/** A variable the selected operation declares. */
interface RustVariable {
  name: string
  /** As written: `ID!`, `[Int]`. */
  type: string
  named_type: string
  non_null: boolean
  default_value: unknown
}
interface RustParseResult {
  operation_type: string
  operation_name: string | null
  fields: RustParsedField[]
  variables: RustVariable[]
  /** The distinct type names the fragments condition on. */
  type_names: string[]
  type_conditions: TypeConditionLink[]
  errors: string[]
}
interface GraphqlNative {
  graphqlParse(
    query: string,
    options?: {
      operationName?: string
      maxDepth?: number
      maxComplexity?: number
      maxErrors?: number
    },
  ): string
  /**
   * `{ "Type": { kind, fields, interfaces, members } }` for every type of the
   * SDL. Throws when the SDL does not parse, or names a type it does not
   * declare.
   */
  graphqlSchemaTypes(sdl: string): string
}

/** What graphql-js answers once `maxErrors` validation errors are collected. */
const TOO_MANY_ERRORS = 'Too many validation errors, error limit reached. Validation aborted.'

/**
 * The validation errors of one request: each message once, and no more than
 * the limit. A request is small; what it can be made to say is not — one
 * field takes as many undeclared arguments as its bytes allow.
 */
class ValidationErrors {
  readonly #messages: string[] = []
  readonly #seen = new Set<string>()
  readonly #max: number
  #full = false

  constructor(max: number) {
    this.#max = Math.max(1, max)
  }

  add(message: string): void {
    if (this.#full || this.#seen.has(message)) return
    if (this.#messages.length >= this.#max) {
      this.#messages.push(TOO_MANY_ERRORS)
      this.#full = true
      return
    }
    this.#seen.add(message)
    this.#messages.push(message)
  }

  /** The limit is reached: nothing more is worth checking. */
  get full(): boolean {
    return this.#full
  }

  get isEmpty(): boolean {
    return this.#messages.length === 0
  }

  toErrors(): Array<{ message: string }> {
    return this.#messages.map((message) => ({ message }))
  }
}

/**
 * Key a `$variable` reference travels under in a parsed argument value:
 * `{ "$var": "id" }`. A GraphQL name cannot start with `$`, so no object
 * literal produces it — and a string literal such as `"$role"` is a string.
 */
const VARIABLE_REFERENCE_KEY = '$var'

/**
 * Coerce an argument value to its schema-declared scalar type. GraphQL input
 * coercion: a string literal `"5"` for an `Int` arg becomes the number `5`, a
 * number for an `ID` becomes its string form, etc. Arrays coerce element-wise.
 * Unknown / custom / enum types pass through untouched.
 */
function coerceScalar(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => coerceScalar(v, type))
  switch (type) {
    case 'Int':
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value))) {
        return Number(value)
      }
      return value
    case 'Float':
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Number(value)
      }
      return value
    case 'Boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      return value
    case 'ID':
      return typeof value === 'number' ? String(value) : value
    default:
      // String, custom scalars, enums, input objects — left as the client sent.
      return value
  }
}

let graphqlNativeCache: GraphqlNative | undefined
/**
 * Lazily load the Rust GraphQL parser from the `index` NAPI binary. There is no
 * TS fallback — when Rust exists, the engine is full-Rust. `loadNapi` throws a
 * `E_REAM_NAPI_NOT_FOUND` if the native module is missing.
 */
function graphqlNative(): GraphqlNative {
  if (graphqlNativeCache === undefined) {
    graphqlNativeCache = loadNapi<GraphqlNative>({
      binaryName: 'index',
      callerMetaUrl: import.meta.url,
    })
  }
  return graphqlNativeCache
}

const OPERATION_TYPE: Record<string, string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
}

/**
 * Bound a parsed selection tree's depth and total field count. Iterative (explicit
 * stack) so a pathological deeply-nested query can't overflow the JS call stack
 * during the check itself, and short-circuits as soon as a limit is crossed.
 * Returns an error message, or `null` when the query is within limits.
 *
 * The second gate. The first runs inside the native parser, WHILE fragments
 * are expanded: checked only here, a few hundred bytes of nested spreads had
 * already expanded to millions of fields and blocked the event loop.
 */
function checkSelectionLimits(
  fields: SelectionField[],
  maxDepth: number,
  maxComplexity: number,
): string | null {
  let count = 0
  const stack: Array<{ field: SelectionField; depth: number }> = fields.map((field) => ({
    field,
    depth: 1,
  }))
  while (stack.length > 0) {
    const top = stack.pop()
    if (!top) break
    if (top.depth > maxDepth) {
      return `Query is too deep (max depth ${maxDepth})`
    }
    count += 1
    if (count > maxComplexity) {
      return `Query is too complex (max ${maxComplexity} fields)`
    }
    for (const child of top.field.selection) {
      stack.push({ field: child, depth: top.depth + 1 })
    }
  }
  return null
}

/** Map a Rust `ParsedField` (sub_fields) onto the engine's `SelectionField` (selection). */
function mapRustField(f: RustParsedField): SelectionField {
  return {
    name: f.name,
    alias: f.alias ?? undefined,
    args: f.args,
    selection: f.sub_fields.map(mapRustField),
    ...(f.condition === null ? {} : { condition: f.condition }),
  }
}

export interface GraphQLConfig {
  /** Path to .graphql schema file. */
  schemaPath: string
  /** Endpoint path (default: /graphql). */
  path?: string
  /** Enable playground/introspection in dev (default: true when NODE_ENV !== 'production'). */
  playground?: boolean
  /**
   * Reject a query string longer than this many characters BEFORE parsing —
   * caps the work the parser does on a hostile payload (default: 100_000).
   */
  maxQueryBytes?: number
  /**
   * Reject a query whose selection set nests deeper than this — bounds
   * resolver recursion / amplification (default: 12).
   */
  maxDepth?: number
  /**
   * Reject a query selecting more than this many fields in total (aliases
   * count) — bounds fan-out where a client repeats an expensive resolver
   * (default: 1000).
   */
  maxComplexity?: number
  /**
   * Stop validating a query after this many errors, and say so (default: 100,
   * as graphql-js `maxErrors`). Without it one small query naming thousands
   * of unknown things is answered with thousands of messages.
   */
  maxErrors?: number
  /**
   * Most times ONE root field may be selected in a single request — aliases
   * are how a client repeats it (default: 10). A rate limit in front of the
   * endpoint counts requests, not resolver calls: this is what bounds how
   * many calls one request is worth. {@link ResolverOptions.maxRepeats}
   * overrides it for one resolver.
   */
  maxFieldRepeats?: number
  /**
   * The same bound for the root fields of a mutation (default: 1): repeating
   * a mutation under aliases is how one request guesses a thousand passwords
   * or one-time codes. Raise it, or set `maxRepeats` on the resolver, for a
   * mutation meant to be batched.
   */
  maxMutationRepeats?: number
  /**
   * Echo the message of any error a resolver throws to the client. Default:
   * only when NODE_ENV is development. Otherwise only a client error (status
   * below 500) or an error flagged `expose: true` keeps its message; anything else reads "Internal server
   * error", and the real error goes to `ctx.logger`.
   */
  debug?: boolean
}

export interface ResolverOptions {
  guard?: string
  guards?: string[]
  role?: string
  roles?: string[]
  permissions?: string[]
  /**
   * Named middleware (from the shared `'middleware'` registry) run before
   * EACH call of the resolver, after its guards — once per alias, where a
   * middleware on the endpoint's route runs once per request. This is where a
   * throttle that must count attempts goes. They refuse by throwing; the
   * response is shared by every field of the request, so a middleware that
   * writes it or does not call `next()` is not supported.
   */
  middleware?: string[]
  /**
   * Most times this field may be selected in one request, instead of the
   * engine's `maxFieldRepeats` / `maxMutationRepeats`.
   */
  maxRepeats?: number
}

interface ResolverEntry {
  typeName: string
  fieldName: string
  handlerClass: abstract new (...args: never[]) => object
  methodName: string
  options: ResolverOptions
}

interface GraphQLRequest {
  query: string
  variables?: Record<string, unknown>
  operationName?: string
}

/** A parsed field with its (possibly nested) selection set. */
export interface SelectionField {
  name: string
  alias?: string
  args: Record<string, unknown>
  selection: SelectionField[]
  /**
   * For a field written inside a fragment: which type condition it sits
   * under (`... on User { name }`), as the parser numbers them.
   */
  condition?: number
}

/** Subset of the IoC container the engine needs. */
interface GraphQLContainer {
  make<T>(target: abstract new (...args: never[]) => T): Promise<T>
  /** With `resolve`: where the named middleware of a resolver are looked up. */
  has?(token: string): boolean
  resolve?<T>(token: string): Promise<T>
}

/** A root field that passed validation: what to call, and with what. */
interface ResolverCall {
  field: SelectionField
  args: Record<string, unknown>
  /** The field's declared return type; undefined for `__typename`. */
  definition: SchemaField | undefined
}

export class GraphQLEngine {
  #schemaSource: string
  #resolvers: Map<string, ResolverEntry> = new Map()
  #container?: GraphQLContainer
  readonly #typeResolvers = new Map<string, TypeResolver>()
  readonly path: string
  #playground: boolean
  readonly #debug: boolean
  #maxQueryBytes: number
  #maxDepth: number
  #maxComplexity: number
  readonly #maxErrors: number
  readonly #maxFieldRepeats: number
  readonly #maxMutationRepeats: number
  /** The lazily-parsed schema, or why it could not be read. */
  #schema?: { ok: true; schema: GraphQLSchema } | { ok: false; error: string }

  /**
   * Parse (once) the schema's types from the SDL: the fields each declares,
   * their return types and their arguments. When it cannot be read, every
   * query is refused: an engine that cannot tell which fields a type has must
   * not pass on whatever a client selects. That includes a schema naming a
   * type it does not declare — the engine could not tell an object, to read
   * field by field, from a scalar, to send as it is.
   */
  #readSchema(): { ok: true; schema: GraphQLSchema } | { ok: false; error: string } {
    if (this.#schema === undefined) {
      try {
        const parsed: unknown = JSON.parse(graphqlNative().graphqlSchemaTypes(this.#schemaSource))
        this.#schema = isSchemaTypes(parsed)
          ? { ok: true, schema: new GraphQLSchema(parsed) }
          : { ok: false, error: 'Unreadable schema type map' }
      } catch (err) {
        // The native refusal is `E_GRAPHQL_INVALID_SCHEMA`; its message, not
        // the JSON it crossed the boundary in, is what the log shows.
        const error = fromNativeError(err)
        this.#schema = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return this.#schema
  }

  constructor(config: GraphQLConfig) {
    if (!fs.existsSync(config.schemaPath)) {
      throw new E_GRAPHQL_SCHEMA_NOT_FOUND([config.schemaPath])
    }
    this.#schemaSource = fs.readFileSync(config.schemaPath, 'utf8')
    this.path = config.path ?? '/graphql'
    this.#playground = config.playground ?? currentNodeEnv() !== 'production'
    this.#maxQueryBytes = config.maxQueryBytes ?? 100_000
    this.#maxDepth = config.maxDepth ?? 12
    this.#maxComplexity = config.maxComplexity ?? 1000
    this.#maxErrors = config.maxErrors ?? 100
    this.#maxFieldRepeats = config.maxFieldRepeats ?? 10
    this.#maxMutationRepeats = config.maxMutationRepeats ?? 1
    this.#debug = config.debug ?? currentNodeEnv() === 'development'
  }

  /** Set IoC container for resolver instantiation. */
  useContainer(container: GraphQLContainer): void {
    this.#container = container
  }

  /**
   * Say which object type a value of an interface or a union is, when the
   * values do not carry `__typename` themselves (graphql-js `resolveType`).
   * The engine reads a value by its object type's fields, so one it cannot
   * name is refused.
   */
  resolveType(abstractType: string, resolver: TypeResolver): void {
    this.#typeResolvers.set(abstractType, resolver)
  }

  /** Register a resolver for a type.field. */
  resolver(
    typeName: string,
    fieldName: string,
    handlerClass: abstract new (...args: never[]) => object,
    methodName: string,
    options?: ResolverOptions,
  ): void {
    const key = `${typeName}.${fieldName}`
    // An empty list reads as a gate and requires nothing: refused here, so a
    // list that came out of configuration empty is found at boot.
    const emptyOption =
      (options?.guards?.length === 0 && options.guard === undefined && 'guards') ||
      (options?.roles?.length === 0 && options.role === undefined && 'roles') ||
      (options?.permissions?.length === 0 && 'permissions')
    if (emptyOption) {
      throw new E_EMPTY_GATE_REQUIREMENT([`GraphQL resolver '${key}'`, `${emptyOption}: []`])
    }
    this.#resolvers.set(key, {
      typeName,
      fieldName,
      handlerClass,
      methodName,
      options: options ?? {},
    })
  }

  /** Handle a GraphQL HTTP request. */
  async handle(ctx: HttpContext): Promise<void> {
    const method = ctx.request.method()

    // Playground
    if (method === 'GET' && this.#playground) {
      ctx.response.header('Content-Type', 'text/html')
      ctx.response.status(200).send(this.#renderPlayground())
      return
    }

    if (method !== 'POST') {
      ctx.response.status(405).json({ errors: [{ message: 'Method not allowed' }] })
      return
    }

    // Only a JSON body is a GraphQL request. A form post, a text/plain body or
    // one with no Content-Type is a CORS simple request: a foreign page sends
    // it with the user's cookies and no preflight, so a mutation would run
    // cross-site. Refused before the body is read.
    const mediaType = (ctx.request.header('content-type')?.split(';')[0] ?? '').trim().toLowerCase()
    if (mediaType !== 'application/json') {
      ctx.response.status(415).json({ errors: [{ message: 'Unsupported Media Type' }] })
      return
    }

    // Read from the raw body rather than `request.body()`, so the endpoint
    // works whether or not the body parser runs in front of it.
    const body = parseGraphQLBody(parseJson(ctx.request.raw()))
    // (`parseJson` drops `__proto__` keys: variables are merged into resolver
    // arguments, where one would swap an object's prototype.)
    if (!body) {
      ctx.response.status(400).json({ errors: [{ message: 'Missing or invalid query' }] })
      return
    }

    try {
      const result = await this.#execute(body, ctx)
      ctx.response.status(200).json(result)
    } catch (err) {
      ctx.response.status(500).json({ errors: [{ message: this.#publicMessage(err, ctx) }] })
    }
  }

  /** Execute a GraphQL query against registered resolvers. */
  async #execute(
    request: GraphQLRequest,
    ctx: HttpContext,
  ): Promise<{
    data?: Record<string, unknown>
    errors?: Array<{ message: string; path?: string[] }>
  }> {
    // DoS guard 1 — cap the raw query size BEFORE handing it to the parser, so a
    // hostile multi-MB payload can't tie up the native parser.
    if (request.query.length > this.#maxQueryBytes) {
      return {
        errors: [{ message: `Query exceeds the maximum size of ${this.#maxQueryBytes} bytes` }],
      }
    }

    // Parse the query to extract operation type and fields. The native parser
    // picks the operation named by `operationName` and bounds the expansion of
    // fragments by maxDepth / maxComplexity as it goes.
    const parsed = this.#parseQuery(request.query, request.operationName)
    if (parsed.errors) {
      return { errors: parsed.errors }
    }

    // DoS guard 2 — bound the selection tree's depth and total field count
    // (aliases included) before resolving anything. Iterative walk so the check
    // itself can't blow the stack on a deeply nested query.
    const limitError = checkSelectionLimits(parsed.fields, this.#maxDepth, this.#maxComplexity)
    if (limitError) {
      return { errors: [{ message: limitError }] }
    }

    // Validation, before ANY resolver runs (a mutation must not half-run):
    // the operation's variables, then every field of the selection — its
    // type, its sub-selection and its arguments — against the schema.
    const schema = this.#readSchema()
    if (!schema.ok) {
      ctx.logger.error('GraphQL schema could not be read', { message: schema.error })
      return { errors: [{ message: 'GraphQL schema could not be read' }] }
    }
    const validationErrors = new ValidationErrors(this.#maxErrors)
    const variables = coerceVariableValues(
      parsed.variables,
      request.variables ?? {},
      validationErrors,
    )
    if (!validationErrors.isEmpty) return { errors: validationErrors.toErrors() }
    const conditions = new TypeConditions(schema.schema, parsed.typeNames, parsed.typeConditions)
    const calls: ResolverCall[] = []
    validateSelection(
      parsed.fields,
      parsed.typeName,
      { schema: schema.schema, conditions, variables, errors: validationErrors },
      calls,
    )
    this.#checkRepeats(calls, parsed.typeName, validationErrors)
    if (!validationErrors.isEmpty) return { errors: validationErrors.toErrors() }

    const projection: ProjectionContext = {
      schema: schema.schema,
      conditions,
      typeResolvers: this.#typeResolvers,
    }
    const data: Record<string, unknown> = {}
    const errors: Array<{ message: string; path?: string[] }> = []

    for (const call of calls) {
      const outcome = await this.#resolveField(call, parsed.typeName, projection, ctx)
      if (outcome.ok) {
        data[call.field.alias ?? call.field.name] = outcome.value
      } else {
        errors.push(outcome.error)
      }
    }

    return {
      data: Object.keys(data).length > 0 ? data : undefined,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * How many times each root field is selected, against its limit. One
   * request runs every alias: without a bound, a limiter that counts requests
   * lets through as many attempts as a query has fields.
   */
  #checkRepeats(calls: ResolverCall[], typeName: string, errors: ValidationErrors): void {
    const counts = new Map<string, number>()
    for (const { field } of calls) {
      counts.set(field.name, (counts.get(field.name) ?? 0) + 1)
    }
    const fallback = typeName === 'Mutation' ? this.#maxMutationRepeats : this.#maxFieldRepeats
    for (const [name, count] of counts) {
      const limit = this.#resolvers.get(`${typeName}.${name}`)?.options.maxRepeats ?? fallback
      if (count > limit) {
        errors.add(
          `Field "${typeName}.${name}" is selected ${count} times in this request; at most ${limit} allowed.`,
        )
      }
    }
  }

  /**
   * Run a resolver's named middleware (from the shared `'middleware'`
   * registry) before one call of it. They refuse by throwing; an unknown
   * name, or no registry to look it up in, is an error and the resolver does
   * not run.
   */
  async #runMiddleware(ctx: HttpContext, names: string[]): Promise<void> {
    const container = this.#container
    const registry =
      container?.has?.('middleware') === true
        ? await container.resolve?.<MiddlewareRegistry>('middleware')
        : undefined
    if (!registry) {
      throw new E_MIDDLEWARE_NOT_FOUND([
        `GraphQL middleware [${names.join(', ')}] is declared but no middleware registry is wired into the GraphQLEngine.`,
      ])
    }
    const fns = names.map((name) => {
      const mw = registry.get(name)
      if (!mw) {
        throw new E_MIDDLEWARE_NOT_FOUND([`Named middleware '${name}' is not registered.`])
      }
      return mw
    })
    await composeMiddleware(fns)(ctx, async () => {})
  }

  /** Resolve one root field: lookup → guards → middleware → invoke → project. */
  async #resolveField(
    call: ResolverCall,
    typeName: string,
    projection: ProjectionContext,
    ctx: HttpContext,
  ): Promise<
    { ok: true; value: unknown } | { ok: false; error: { message: string; path?: string[] } }
  > {
    const { field, args, definition } = call
    // `__typename` is the one field every type has without declaring it.
    if (definition === undefined) return { ok: true, value: typeName }
    const key = `${typeName}.${field.name}`
    const entry = this.#resolvers.get(key)
    if (!entry) {
      return {
        ok: false,
        error: { message: `No resolver for ${key}`, path: [field.name] },
      }
    }

    const guardError = await this.#enforceGuards(entry.options, ctx)
    if (guardError) {
      return { ok: false, error: { message: guardError, path: [field.name] } }
    }

    try {
      const middleware = entry.options.middleware ?? []
      if (middleware.length > 0) await this.#runMiddleware(ctx, middleware)

      // Resolve handler via IoC or direct instantiation.
      // `Reflect.construct`, not `new`: the resolver may be an abstract class,
      // which the runtime builds happily and `new` refuses at compile time.
      const instance: object = this.#container
        ? await this.#container.make(entry.handlerClass)
        : Reflect.construct(entry.handlerClass, [])

      const handler = Reflect.get(instance, entry.methodName)
      if (typeof handler !== 'function') {
        return {
          ok: false,
          error: {
            message: `Resolver method ${entry.methodName} not found`,
            path: [field.name],
          },
        }
      }

      const result = await handler.call(instance, null, args, ctx)
      // Read by the schema: of a rich object (an ORM entity), only the
      // fields the client selected and the value's type declares go out.
      return {
        ok: true,
        value: projectValue(result, definition.type, field.selection, projection, key),
      }
    } catch (err) {
      return { ok: false, error: { message: this.#publicMessage(err, ctx), path: [field.name] } }
    }
  }

  /**
   * The message a client may see for a thrown error — the rule the HTTP
   * exception handler applies. A driver or library error carries internal
   * hosts, credentials and stored values in its text, so outside debug it is
   * collapsed, and the original is logged for the operator instead.
   */
  #publicMessage(err: unknown, ctx: HttpContext): string {
    const message = err instanceof Error ? err.message : String(err)
    if (this.#debug || isPublicError(err)) return message
    ctx.logger.error('GraphQL resolver failed', {
      message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    return 'Internal server error'
  }

  /** Enforce guard/role/permission on a resolver. */
  async #enforceGuards(options: ResolverOptions, ctx: HttpContext): Promise<string | null> {
    const guards = [...(options.guards ?? []), ...(options.guard ? [options.guard] : [])]
    const roles = [...(options.roles ?? []), ...(options.role ? [options.role] : [])]
    const permissions = options.permissions ?? []

    // A guard list names who may vouch for the request — shared with the
    // route and RPC gates. A guard's 401 is a denial here; a crash behind it
    // is not, and propagates.
    if (guards.length > 0) {
      try {
        if (!(await authenticatedByGuards(ctx.auth, guards))) return 'Unauthorized'
      } catch (err) {
        if (isUnauthorizedError(err)) return 'Unauthorized'
        throw err
      }
    }
    const needsAuth = roles.length > 0 || permissions.length > 0
    if (needsAuth && !ctx.auth?.isAuthenticated) {
      return 'Unauthorized'
    }

    // Read roles/permissions from the top level OR nested under `user` — the
    // auth provider (e.g. warden) sets `ctx.auth.user.roles`, not the top level.
    // Mirrors the HTTP guard middleware fix.
    if (roles.length > 0) {
      const userRoles = ctx.auth?.roles ?? ctx.auth?.user?.roles ?? []
      if (!roles.some((r) => userRoles.includes(r))) {
        return 'Insufficient role'
      }
    }

    // A token-authenticated request also needs the token to allow each one.
    if (permissions.length > 0) {
      if (!(await holdsPermissions(ctx.auth, permissions))) {
        return 'Insufficient permissions'
      }
    }

    return null
  }

  /**
   * Parse a GraphQL query via the Rust `ream-graphql` crate (operation type +
   * fields with arguments). Spec-compliant; invalid queries return errors.
   */
  #parseQuery(
    query: string,
    operationName: string | undefined,
  ): {
    typeName: string
    fields: SelectionField[]
    variables: RustVariable[]
    typeNames: string[]
    typeConditions: TypeConditionLink[]
    errors?: Array<{ message: string }>
  } {
    // Full-Rust: the spec-compliant `ream-graphql` parser (graphql-parser
    // crate) rejects invalid queries before any resolver runs. No TS fallback —
    // ream ships the native binary, so when Rust exists the engine is Rust.
    // `safeJsonParse`: a client's object literal may name a key `__proto__`.
    const options = {
      ...(operationName === undefined ? {} : { operationName }),
      maxDepth: this.#maxDepth,
      maxComplexity: this.#maxComplexity,
      maxErrors: this.#maxErrors,
    }
    const raw: unknown = safeJsonParse(
      callNative(() => graphqlNative().graphqlParse(query, options)),
    )
    if (!isRustParseResult(raw)) {
      return {
        typeName: 'Query',
        fields: [],
        variables: [],
        typeNames: [],
        typeConditions: [],
        errors: [{ message: 'Unreadable parse result' }],
      }
    }
    const typeName = OPERATION_TYPE[raw.operation_type] ?? 'Query'
    if (raw.errors.length > 0) {
      return {
        typeName,
        fields: [],
        variables: [],
        typeNames: [],
        typeConditions: [],
        errors: raw.errors.map((message) => ({ message })),
      }
    }
    return {
      typeName,
      fields: raw.fields.map(mapRustField),
      variables: raw.variables,
      typeNames: raw.type_names,
      typeConditions: raw.type_conditions,
    }
  }

  /**
   * GraphiQL from jsDelivr, each file at an exact version and with its
   * Subresource Integrity hash: the browser refuses a file the CDN serves
   * different from the one hashed here, so a compromised CDN or package
   * cannot run code on the page. React stays on 18: GraphiQL 3's browser
   * build reads the `React` global, which only React 18's UMD files define
   * (19 ships none). Moving a version means recomputing its hash:
   * `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
   */
  #renderPlayground(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>GraphQL Playground</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphiql@3.9.0/graphiql.min.css" integrity="sha384-QMux00XgRtwRLSYIY3kw2rj1ovk5AuuliAchk+HSQbqdbGFnz9GYuqIlOqxhwCE2" crossorigin="anonymous" />
</head>
<body style="margin:0;overflow:hidden">
  <div id="graphiql" style="height:100vh"></div>
  <script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js" integrity="sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js" integrity="sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/graphiql@3.9.0/graphiql.min.js" integrity="sha384-8NGfVj4CVlqHajlZj+bPJT4thxPMHMJYn7DWK2CvtopLd02E7qsPHazniBYvVjOO" crossorigin="anonymous"></script>
  <script>
    const root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(React.createElement(GraphiQL, {
      fetcher: GraphiQL.createFetcher({ url: ${JSON.stringify(this.path)} }),
    }));
  </script>
</body>
</html>`
  }

  /** Get the raw schema source for introspection. */
  getSchemaSource(): string {
    return this.#schemaSource
  }
}

/** Parse and validate an unknown request body as a GraphQL request object. */
/** GraphQL `variables` must be a keyed object — never an array or null. */
function isVariablesRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A client error, or an error flagged `expose: true`. Being an `Exception` is
 * not a reason: every package raises flare `Exception`s, and a 500 one names
 * hosts, paths and queries.
 */
function isPublicError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  if ('expose' in err && err.expose === true) return true
  return 'status' in err && typeof err.status === 'number' && err.status < 500
}

/** The request body, `__proto__` keys dropped (AdonisJS `safeParse`). */
function parseJson(raw: string): unknown {
  try {
    return safeJsonParse(raw)
  } catch {
    return undefined
  }
}

function parseGraphQLBody(body: unknown): GraphQLRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  // After typeof check, body is a non-null non-array object; index via 'in' narrowing
  const q = 'query' in body ? body.query : undefined
  if (typeof q !== 'string') return null

  let variables: Record<string, unknown> | undefined
  if ('variables' in body && isVariablesRecord(body.variables)) {
    variables = body.variables
  }

  const rawOpName = 'operationName' in body ? body.operationName : undefined
  const operationName = typeof rawOpName === 'string' ? rawOpName : undefined

  return { query: q, variables, operationName }
}

/** The shape the native parser answers with, checked rather than assumed. */
function isRustParseResult(value: unknown): value is RustParseResult {
  if (!isRecord(value)) return false
  return (
    typeof value.operation_type === 'string' &&
    (value.operation_name === null || typeof value.operation_name === 'string') &&
    Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === 'string') &&
    Array.isArray(value.fields) &&
    value.fields.every(isRustParsedField) &&
    Array.isArray(value.variables) &&
    value.variables.every(isRustVariable) &&
    Array.isArray(value.type_names) &&
    value.type_names.every((name) => typeof name === 'string') &&
    Array.isArray(value.type_conditions) &&
    value.type_conditions.every(isTypeConditionLink)
  )
}

function isTypeConditionLink(value: unknown): value is TypeConditionLink {
  return (
    isRecord(value) &&
    typeof value.name === 'number' &&
    (value.parent === null || typeof value.parent === 'number')
  )
}

function isRustVariable(value: unknown): value is RustVariable {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.named_type === 'string' &&
    typeof value.non_null === 'boolean'
  )
}

/**
 * The operation's variable values (graphql-js `coerceVariableValues`): one per
 * variable the operation DECLARES — a request variable it does not declare is
 * dropped — its default when the request leaves it out, and an error for a
 * non-null one missing or null.
 */
function coerceVariableValues(
  definitions: RustVariable[],
  inputs: Record<string, unknown>,
  errors: ValidationErrors,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const definition of definitions) {
    if (errors.full) break
    if (!Object.hasOwn(inputs, definition.name)) {
      if (definition.default_value !== null && definition.default_value !== undefined) {
        values[definition.name] = coerceScalar(definition.default_value, definition.named_type)
      } else if (definition.non_null) {
        errors.add(
          `Variable "$${definition.name}" of required type "${definition.type}" was not provided.`,
        )
      }
      continue
    }
    const value = inputs[definition.name]
    if (value === null && definition.non_null) {
      errors.add(
        `Variable "$${definition.name}" of non-null type "${definition.type}" must not be null.`,
      )
      continue
    }
    values[definition.name] = coerceScalar(value, definition.named_type)
  }
  return values
}

/** `{ "$var": "name" }` — a variable reference the parser left in an argument value. */
function variableReference(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  const name = value[VARIABLE_REFERENCE_KEY]
  return keys.length === 1 && typeof name === 'string' ? name : undefined
}

/**
 * Replace the variable references inside an argument literal by their values.
 * A variable with no value leaves a list item `null` and drops an object
 * field, as graphql-js does.
 */
function substituteVariables(value: unknown, variables: Record<string, unknown>): unknown {
  const reference = variableReference(value)
  if (reference !== undefined) {
    return Object.hasOwn(variables, reference) ? variables[reference] : undefined
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVariables(item, variables) ?? null)
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const substituted = substituteVariables(item, variables)
      if (substituted !== undefined) out[key] = substituted
    }
    return out
  }
  return value
}

/** What a selection is validated with. */
interface ValidationContext {
  schema: GraphQLSchema
  conditions: TypeConditions
  variables: Record<string, unknown>
  errors: ValidationErrors
}

/**
 * Check a selection set against the schema, at every depth (the graphql-js
 * rules FieldsOnCorrectType, ScalarLeafs, KnownTypeNames,
 * FragmentsOnCompositeTypes, PossibleFragmentSpreads, KnownArgumentNames and
 * ProvidedRequiredArguments, with their messages).
 *
 * `parentType` is the type the selection is on. A field is looked up on it,
 * or on the type its fragment conditions on. It must be declared there; one
 * whose type has fields must select some, and one whose type has none must
 * not. Only the root level was checked once: below it a client named any
 * property of what a resolver returned, or no property at all and got the
 * object whole.
 *
 * `calls` collects the fields that passed, with their coerced arguments: the
 * root fields, which are the ones a resolver runs for.
 */
function validateSelection(
  fields: SelectionField[],
  parentType: string,
  context: ValidationContext,
  calls?: ResolverCall[],
): void {
  const { schema, errors } = context
  for (const field of fields) {
    if (errors.full) return
    let scoped = parentType
    if (field.condition !== undefined) {
      const condition = context.conditions.get(field.condition)
      if (condition === undefined) {
        errors.add('Unreadable type condition')
        continue
      }
      if (condition.error !== undefined) {
        errors.add(condition.error)
        continue
      }
      if (!overlaps(schema.possibleTypes(parentType), condition.types)) {
        errors.add(
          `Fragment cannot be spread here as objects of type "${parentType}" can never be of type "${condition.name}".`,
        )
        continue
      }
      scoped = condition.name
    }
    if (field.name === '__typename' && schema.isComposite(scoped)) {
      for (const name of Object.keys(field.args)) {
        errors.add(`Unknown argument "${name}" on field "${scoped}.__typename".`)
      }
      if (field.selection.length > 0) {
        errors.add(
          'Field "__typename" must not have a selection since type "String!" has no subfields.',
        )
      }
      calls?.push({ field, args: {}, definition: undefined })
      continue
    }
    const definition = schema.field(scoped, field.name)
    if (definition === undefined) {
      errors.add(`Cannot query field "${field.name}" on type "${scoped}".`)
      continue
    }
    const args = coerceArgumentValues(
      field,
      `${scoped}.${field.name}`,
      definition.args,
      context.variables,
      errors,
    )
    if (schema.isComposite(definition.named_type)) {
      if (field.selection.length === 0) {
        errors.add(
          `Field "${field.name}" of type "${definition.type}" must have a selection of subfields. Did you mean "${field.name} { ... }"?`,
        )
      } else {
        validateSelection(field.selection, definition.named_type, context)
      }
    } else if (field.selection.length > 0) {
      errors.add(
        `Field "${field.name}" must not have a selection since type "${definition.type}" has no subfields.`,
      )
    }
    calls?.push({ field, args, definition })
  }
}

/**
 * The arguments a resolver receives (graphql-js `getArgumentValues`, with the
 * KnownArgumentNames and ProvidedRequiredArguments checks): only those the
 * schema declares for the field at `coordinate` (`Type.field`), variables
 * substituted, defaults applied, scalars coerced to their declared types.
 *
 * Built from the declaration, never from what the client sent: an argument
 * the field does not declare is refused instead of reaching a resolver that
 * spreads `args` into a model (`role`, `isAdmin`, `ownerId`).
 */
function coerceArgumentValues(
  field: SelectionField,
  coordinate: string,
  declared: Record<string, SchemaArg>,
  variables: Record<string, unknown>,
  errors: ValidationErrors,
): Record<string, unknown> {
  for (const name of Object.keys(field.args)) {
    if (errors.full) break
    if (!Object.hasOwn(declared, name)) {
      errors.add(`Unknown argument "${name}" on field "${coordinate}".`)
    }
  }
  const args: Record<string, unknown> = {}
  for (const [name, definition] of Object.entries(declared)) {
    const label = `Argument "${coordinate}(${name}:)"`
    const hasDefault = definition.default_value !== null && definition.default_value !== undefined
    if (!Object.hasOwn(field.args, name)) {
      if (definition.required) {
        errors.add(`${label} of type "${definition.type}" is required, but it was not provided.`)
      } else if (hasDefault) {
        args[name] = coerceScalar(definition.default_value, definition.named_type)
      }
      continue
    }
    const literal = field.args[name]
    const reference = variableReference(literal)
    if (reference !== undefined && !Object.hasOwn(variables, reference)) {
      // The variable has no runtime value: the argument's default, if any.
      if (definition.required) {
        errors.add(
          `${label} of required type "${definition.type}" was provided the variable "$${reference}" which was not provided a runtime value.`,
        )
      } else if (hasDefault) {
        args[name] = coerceScalar(definition.default_value, definition.named_type)
      }
      continue
    }
    const value = substituteVariables(literal, variables)
    if (value === null && definition.type.endsWith('!')) {
      errors.add(
        `${label} has invalid value: Expected value of non-null type "${definition.type}" not to be null.`,
      )
      continue
    }
    args[name] = coerceScalar(value, definition.named_type)
  }
  return args
}

function isRustParsedField(value: unknown): value is RustParsedField {
  if (!isRecord(value)) return false
  return (
    typeof value.name === 'string' &&
    (value.alias === null || typeof value.alias === 'string') &&
    isRecord(value.args) &&
    Array.isArray(value.sub_fields) &&
    value.sub_fields.every(isRustParsedField) &&
    (value.condition === null || typeof value.condition === 'number')
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

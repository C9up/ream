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
 * - The response is pruned to the client's selection set, so a resolver may
 *   safely return a rich object (e.g. an ORM entity): fields the client did
 *   not select are dropped before serialization.
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
import { loadNapi } from '../helpers/napi-loader.js'
import type { HttpContext } from '../http/HttpContext.js'

/** Rust parser output (the `ream-graphql` crate via the `index` NAPI binary). */
interface RustParsedField {
  name: string
  alias: string | null
  args: Record<string, unknown>
  sub_fields: RustParsedField[]
}
interface RustParseResult {
  operation_type: string
  operation_name: string | null
  fields: RustParsedField[]
  errors: string[]
}
interface GraphqlNative {
  graphqlParse(query: string): string
}

let graphqlNativeCache: GraphqlNative | undefined
/**
 * Lazily load the Rust GraphQL parser from the `index` NAPI binary. There is no
 * TS fallback — when Rust exists, the engine is full-Rust. `loadNapi` throws a
 * typed `ReamError` if the native module is missing.
 */
function graphqlNative(): GraphqlNative {
  if (graphqlNativeCache === undefined) {
    graphqlNativeCache = loadNapi<GraphqlNative>({
      binaryName: 'index',
      callerMetaUrl: import.meta.url,
      errorCodePrefix: 'GRAPHQL',
    })
  }
  return graphqlNativeCache
}

const OPERATION_TYPE: Record<string, string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
}

/** Map a Rust `ParsedField` (sub_fields) onto the engine's `SelectionField` (selection). */
function mapRustField(f: RustParsedField): SelectionField {
  return {
    name: f.name,
    alias: f.alias ?? undefined,
    args: f.args,
    selection: f.sub_fields.map(mapRustField),
  }
}

export interface GraphQLConfig {
  /** Path to .graphql schema file. */
  schemaPath: string
  /** Endpoint path (default: /graphql). */
  path?: string
  /** Enable playground/introspection in dev (default: true when NODE_ENV !== 'production'). */
  playground?: boolean
}

export interface ResolverOptions {
  guard?: string
  guards?: string[]
  role?: string
  roles?: string[]
  permissions?: string[]
}

interface ResolverEntry {
  typeName: string
  fieldName: string
  handlerClass: new (...args: unknown[]) => Record<string, (...args: unknown[]) => unknown>
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
}

export class GraphQLEngine {
  #schemaSource: string
  #resolvers: Map<string, ResolverEntry> = new Map()
  #container?: { make<T>(target: new (...args: unknown[]) => T): T }
  readonly path: string
  #playground: boolean

  constructor(config: GraphQLConfig) {
    if (!fs.existsSync(config.schemaPath)) {
      throw new Error(`GraphQL schema not found: ${config.schemaPath}`)
    }
    this.#schemaSource = fs.readFileSync(config.schemaPath, 'utf8')
    this.path = config.path ?? '/graphql'
    this.#playground = config.playground ?? process.env.NODE_ENV !== 'production'
  }

  /** Set IoC container for resolver instantiation. */
  useContainer(container: { make<T>(target: new (...args: unknown[]) => T): T }): void {
    this.#container = container
  }

  /** Register a resolver for a type.field. */
  resolver(
    typeName: string,
    fieldName: string,
    handlerClass: new (...args: unknown[]) => Record<string, (...args: unknown[]) => unknown>,
    methodName: string,
    options?: ResolverOptions,
  ): void {
    const key = `${typeName}.${fieldName}`
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

    const rawBody = ctx.request.body()
    const body = parseGraphQLBody(rawBody)
    if (!body) {
      ctx.response.status(400).json({ errors: [{ message: 'Missing or invalid query' }] })
      return
    }

    try {
      const result = await this.#execute(body, ctx)
      ctx.response.status(200).json(result)
    } catch (err) {
      const message =
        process.env.NODE_ENV !== 'production' && err instanceof Error
          ? err.message
          : 'Internal server error'
      ctx.response.status(500).json({ errors: [{ message }] })
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
    // Parse the query to extract operation type and fields
    const parsed = this.#parseQuery(request.query)
    if (parsed.errors) {
      return { errors: parsed.errors }
    }

    const data: Record<string, unknown> = {}
    const errors: Array<{ message: string; path?: string[] }> = []

    for (const field of parsed.fields) {
      const outcome = await this.#resolveField(field, parsed.typeName, request, ctx)
      if (outcome.ok) {
        data[field.alias ?? field.name] = outcome.value
      } else {
        errors.push(outcome.error)
      }
    }

    return {
      data: Object.keys(data).length > 0 ? data : undefined,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /** Resolve one selection field: lookup → guards → invoke → prune. */
  async #resolveField(
    field: SelectionField,
    typeName: string,
    request: GraphQLRequest,
    ctx: HttpContext,
  ): Promise<
    { ok: true; value: unknown } | { ok: false; error: { message: string; path?: string[] } }
  > {
    const key = `${typeName}.${field.name}`
    const entry = this.#resolvers.get(key)
    if (!entry) {
      return {
        ok: false,
        error: { message: `No resolver for ${key}`, path: [field.name] },
      }
    }

    const guardError = this.#enforceGuards(entry.options, ctx)
    if (guardError) {
      return { ok: false, error: { message: guardError, path: [field.name] } }
    }

    try {
      // Resolve handler via IoC or direct instantiation.
      const instance = this.#container
        ? this.#container.make(entry.handlerClass)
        : new entry.handlerClass()

      const handler = instance[entry.methodName]
      if (typeof handler !== 'function') {
        return {
          ok: false,
          error: {
            message: `Resolver method ${entry.methodName} not found`,
            path: [field.name],
          },
        }
      }

      const args = this.#buildArgs(field, request.variables)
      const result = await handler.call(instance, null, args, ctx)
      // Prune to the client's selection set: a resolver returning a rich
      // object (ORM entity, etc.) must not leak fields the client did not
      // ask for. Empty selection (scalar field) returns the value as-is.
      return { ok: true, value: pruneToSelection(result, field.selection) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resolver error'
      return { ok: false, error: { message: msg, path: [field.name] } }
    }
  }

  /**
   * Build the resolver argument bag: `$variable` references resolve against
   * `request.variables`, then any unreferenced variables are merged in.
   */
  #buildArgs(
    field: SelectionField,
    variables: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(field.args)) {
      if (typeof v === 'string' && v.startsWith('$') && variables) {
        args[k] = variables[v.slice(1)]
      } else {
        args[k] = v
      }
    }
    if (variables) {
      for (const [k, v] of Object.entries(variables)) {
        if (!(k in args)) args[k] = v
      }
    }
    return args
  }

  /** Enforce guard/role/permission on a resolver. */
  #enforceGuards(options: ResolverOptions, ctx: HttpContext): string | null {
    const guards = [...(options.guards ?? []), ...(options.guard ? [options.guard] : [])]
    const roles = [...(options.roles ?? []), ...(options.role ? [options.role] : [])]
    const permissions = options.permissions ?? []

    const needsAuth = guards.length > 0 || roles.length > 0 || permissions.length > 0
    if (needsAuth && !ctx.auth?.authenticated) {
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

    if (permissions.length > 0) {
      const userPerms = ctx.auth?.permissions ?? ctx.auth?.user?.permissions ?? []
      if (!permissions.every((p) => userPerms.includes(p))) {
        return 'Insufficient permissions'
      }
    }

    return null
  }

  /**
   * Parse a GraphQL query via the Rust `ream-graphql` crate (operation type +
   * fields with arguments). Spec-compliant; invalid queries return errors.
   */
  #parseQuery(query: string): {
    typeName: string
    fields: SelectionField[]
    errors?: Array<{ message: string }>
  } {
    // Full-Rust: the spec-compliant `ream-graphql` parser (graphql-parser
    // crate) rejects invalid queries before any resolver runs. No TS fallback —
    // ream ships the native binary, so when Rust exists the engine is Rust.
    const raw = JSON.parse(graphqlNative().graphqlParse(query)) as RustParseResult
    const typeName = OPERATION_TYPE[raw.operation_type] ?? 'Query'
    if (raw.errors.length > 0) {
      return { typeName, fields: [], errors: raw.errors.map((message) => ({ message })) }
    }
    return { typeName, fields: raw.fields.map(mapRustField) }
  }

  #renderPlayground(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>GraphQL Playground</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphiql@3/graphiql.min.css" />
</head>
<body style="margin:0;overflow:hidden">
  <div id="graphiql" style="height:100vh"></div>
  <script crossorigin src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://cdn.jsdelivr.net/npm/graphiql@3/graphiql.min.js"></script>
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
function parseGraphQLBody(body: unknown): GraphQLRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  // After typeof check, body is a non-null non-array object; index via 'in' narrowing
  const q = 'query' in body ? body.query : undefined
  if (typeof q !== 'string') return null

  let variables: Record<string, unknown> | undefined
  if (
    'variables' in body &&
    body.variables !== null &&
    typeof body.variables === 'object' &&
    !Array.isArray(body.variables)
  ) {
    // biome-ignore lint/suspicious/noExplicitAny: narrowed to non-null non-array object above; branded as Record for safe spreading
    variables = body.variables as any as Record<string, unknown>
  }

  const rawOpName = 'operationName' in body ? body.operationName : undefined
  const operationName = typeof rawOpName === 'string' ? rawOpName : undefined

  return { query: q, variables, operationName }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Project a resolver result onto the client's selection set. A field with an
 * empty selection (a scalar leaf) is returned untouched; an object is reduced
 * to only the selected keys (recursing into nested selections); an array maps
 * the projection over its items. This is what stops a resolver that returns a
 * rich object (ORM entity, etc.) from leaking unselected fields.
 */
export function pruneToSelection(value: unknown, selection: SelectionField[]): unknown {
  if (selection.length === 0) return value
  if (Array.isArray(value)) return value.map((v) => pruneToSelection(v, selection))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const field of selection) {
    if (field.name in value) {
      out[field.alias ?? field.name] = pruneToSelection(value[field.name], field.selection)
    }
  }
  return out
}

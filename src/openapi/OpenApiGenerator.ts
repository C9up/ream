/**
 * OpenApiGenerator — auto-generates OpenAPI 3.1 spec from registered routes and Rune schemas.
 *
 * Zero manual spec writing. Routes, validators, guards, and versions are introspected at boot.
 *
 * Usage:
 *   const spec = new OpenApiGenerator(router, { title: 'My API', version: '1.0.0' }).generate()
 *
 * @implements MISS-22
 */

import type { RouteDefinition, Router } from '../router/Router.js'

export interface OpenApiConfig {
  title: string
  version: string
  description?: string
  servers?: Array<{ url: string; description?: string }>
  contact?: { name?: string; email?: string; url?: string }
  license?: { name: string; url?: string }
}

// `type` (not `interface`) so the generated spec is assignable to
// `Record<string, unknown>` — OpenApiMiddleware accepts the spec as a plain
// record, and a `type` alias carries the implicit index signature an
// (augmentable) interface would not.
type OpenApiSpec = {
  openapi: string
  info: {
    title: string
    version: string
    description?: string
    contact?: Record<string, string>
    license?: Record<string, string>
  }
  servers?: Array<{ url: string; description?: string }>
  paths: Record<string, Record<string, unknown>>
  components: {
    securitySchemes: Record<string, unknown>
    schemas: Record<string, unknown>
  }
}

/** Map a guard name to its OpenAPI security-scheme object. */
function buildSecurityScheme(guard: string): Record<string, unknown> {
  if (guard === 'jwt') {
    return { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
  }
  if (guard === 'api-key' || guard === 'apikey') {
    return { type: 'apiKey', in: 'header', name: 'X-API-Key' }
  }
  return { type: 'http', scheme: 'bearer' }
}

export class OpenApiGenerator {
  #router: Router
  #config: OpenApiConfig
  #runeSchemas: Map<string, Record<string, unknown>>
  /**
   * Schemas a validator produced itself, already in JSON Schema form.
   *
   * Kept apart from {@link #runeSchemas}, which holds rune FIELD MAPS that
   * {@link #runeToJsonSchema} still has to convert. One map for both would
   * mean guessing which kind a value is, and guessing wrong sends a finished
   * schema back through the converter, which reads its `type` and `properties`
   * keys as if they were field names.
   */
  #jsonSchemas = new Map<string, Record<string, unknown>>()

  constructor(
    router: Router,
    config: OpenApiConfig,
    runeSchemas?: Map<string, Record<string, unknown>>,
  ) {
    this.#router = router
    this.#config = config
    this.#runeSchemas = runeSchemas ?? new Map()
  }

  /** Register a Rune validation schema for OpenAPI spec generation. */
  registerSchema(name: string, definition: Record<string, unknown>): void {
    this.#runeSchemas.set(name, definition)
  }

  /**
   * Fill the schema map from the validators the routes already name.
   *
   * `route.validate('createUser')` records a container token, and the
   * validator behind it can describe itself. Without this step every one of
   * those routes documented its body as a bare `{ type: 'object' }` unless the
   * app ALSO called `registerSchema` by hand with a definition it had to keep
   * in step with the schema — two descriptions of one payload, and nothing
   * checking they agreed.
   *
   * Resolution happens once, here, because `generate()` is synchronous and the
   * container is not. A validator that cannot be resolved, or that cannot
   * describe itself, is skipped: a missing section of documentation is a
   * smaller problem than a boot that fails over one.
   */
  async hydrateSchemas(resolve: (token: string) => Promise<unknown>): Promise<void> {
    const names = new Set(this.#getRoutes().flatMap((route) => route.validators))
    for (const name of names) {
      if (this.#runeSchemas.has(name) || this.#jsonSchemas.has(name)) continue
      const definition = await describeValidator(resolve, name)
      if (definition !== undefined) this.#jsonSchemas.set(name, definition)
    }
  }

  /** Generate the complete OpenAPI 3.1 spec. */
  generate(): OpenApiSpec {
    const spec: OpenApiSpec = {
      openapi: '3.1.0',
      info: {
        title: this.#config.title,
        version: this.#config.version,
        ...(this.#config.description ? { description: this.#config.description } : {}),
        ...(this.#config.contact ? { contact: this.#config.contact } : {}),
        ...(this.#config.license ? { license: this.#config.license } : {}),
      },
      ...(this.#config.servers ? { servers: this.#config.servers } : {}),
      paths: {},
      components: {
        securitySchemes: {},
        schemas: {},
      },
    }

    // Build paths from router
    const routes = this.#getRoutes()
    const securitySchemesUsed = new Set<string>()

    for (const route of routes) {
      const method = route.method.toLowerCase()
      if (method === '*') continue // skip wildcard routes

      const path = this.#convertPath(route.path)

      if (!spec.paths[path]) spec.paths[path] = {}

      spec.paths[path][method] = this.#buildOperation(
        route,
        method,
        path,
        securitySchemesUsed,
        spec.components.schemas,
      )
    }

    // Security schemes
    for (const guard of securitySchemesUsed) {
      spec.components.securitySchemes[guard] = buildSecurityScheme(guard)
    }

    return spec
  }

  /**
   * Build the OpenAPI operation object for one route. Records any guard names in
   * `securitySchemesUsed` and registers validator request-body schemas into the
   * shared `schemas` component map.
   */
  #buildOperation(
    route: RouteDefinition,
    method: string,
    path: string,
    securitySchemesUsed: Set<string>,
    schemas: Record<string, unknown>,
  ): Record<string, unknown> {
    const operation: Record<string, unknown> = {
      summary: this.#generateSummary(route),
      responses: {
        '200': { description: 'Success' },
        ...(route.guards.length > 0 ? { '401': { description: 'Unauthorized' } } : {}),
        ...(route.roles.length > 0 || route.permissions.length > 0
          ? { '403': { description: 'Forbidden' } }
          : {}),
      },
    }

    // Tags from path prefix
    const tag = path.split('/').filter(Boolean)[1] // e.g., /api/v1/tasks → "v1"
    if (tag) operation.tags = [tag]

    if (route.version) operation['x-api-version'] = route.version

    if (route.deprecates) {
      operation.deprecated = true
      operation['x-sunset'] = route.deprecates.sunset
    }

    const params = this.#extractPathParams(route.path)
    if (params.length > 0) {
      operation.parameters = params.map((p) => ({
        name: p,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }))
    }

    if (route.guards.length > 0) {
      operation.security = route.guards.map((g) => ({ [g]: [] }))
      for (const g of route.guards) securitySchemesUsed.add(g)
    }

    if (route.validators.length > 0 && ['post', 'put', 'patch'].includes(method)) {
      const [validatorName] = route.validators
      const body = validatorName === undefined ? undefined : this.#bodySchema(validatorName)
      if (body && validatorName !== undefined) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: body } },
        }
        schemas[validatorName] = body
      } else {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        }
      }
    }

    return operation
  }

  /** Convert Express-style path params to OpenAPI format. */
  #convertPath(path: string): string {
    return path.replace(/:(\w+)\??/g, '{$1}')
  }

  /** Extract parameter names from path. */
  #extractPathParams(path: string): string[] {
    const matches = path.matchAll(/:(\w+)\??/g)
    // Group 1 is required by the pattern, so every match carries it; the
    // filter is how that is stated instead of asserted.
    return [...matches].map((m) => m[1]).filter((name) => name !== undefined)
  }

  /** Generate a summary from route metadata. */
  #generateSummary(route: RouteDefinition): string {
    if (route.controller) {
      return `${route.controller.target.name}.${route.controller.method}`
    }
    if (route.name) return route.name
    return `${route.method} ${route.path}`
  }

  /**
   * The JSON Schema for a named validator: what it described about itself
   * first, then a hand-registered field map converted here.
   */
  #bodySchema(name: string): Record<string, unknown> | undefined {
    const described = this.#jsonSchemas.get(name)
    if (described !== undefined) return described
    const fields = this.#runeSchemas.get(name)
    return fields === undefined ? undefined : this.#runeToJsonSchema(fields)
  }

  /** Convert a Rune schema (Record<string, RuleChain>) to JSON Schema. */
  #runeToJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [field, chainRaw] of Object.entries(schema)) {
      const chain = chainRaw as {
        rules?: ReadonlyArray<{ name: string; param?: number }>
        isOptionalField?: boolean
      }
      let type = 'string'
      const constraints: Record<string, unknown> = {}

      for (const rule of chain.rules ?? []) {
        if (rule.name === 'string') type = 'string'
        else if (rule.name === 'number') type = 'number'
        else if (rule.name === 'boolean') type = 'boolean'
        else if (rule.name === 'email') constraints.format = 'email'
        else if (rule.name === 'min' && rule.param !== undefined) {
          if (type === 'string') constraints.minLength = rule.param
          else constraints.minimum = rule.param
        } else if (rule.name === 'max' && rule.param !== undefined) {
          if (type === 'string') constraints.maxLength = rule.param
          else constraints.maximum = rule.param
        }
      }

      properties[field] = { type, ...constraints }
      if (!chain.isOptionalField) required.push(field)
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  }

  /** Get all routes from the router via public API. */
  #getRoutes(): RouteDefinition[] {
    return this.#router.getRoutes()
  }
}

/** A validator that can describe its own shape as JSON Schema. */
interface SelfDescribingValidator {
  toJSONSchema(): Record<string, unknown>
}

function describesItself(value: unknown): value is SelfDescribingValidator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toJSONSchema' in value &&
    typeof value.toJSONSchema === 'function'
  )
}

/** Resolve one validator and ask it for its schema, or answer undefined. */
async function describeValidator(
  resolve: (token: string) => Promise<unknown>,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  let validator: unknown
  try {
    validator = await resolve(`validator:${name}`)
  } catch {
    // An unregistered validator is already a hard error at request time; the
    // documentation is not the place to raise it a second time.
    return undefined
  }
  if (!describesItself(validator)) return undefined
  try {
    return validator.toJSONSchema()
  } catch {
    return undefined
  }
}

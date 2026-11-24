/**
 * The schema a GraphQL engine serves — the types the native parser reads from
 * the SDL — and the two things decided against it: which type a fragment's
 * fields apply to, and what of a resolver's result goes out.
 *
 * The schema is the contract. A field no type declares is never read from a
 * value, whatever the value holds and whatever the client asks for.
 */

import { E_GRAPHQL_INVALID_RESULT } from '../errors/codes.js'

/** One declared argument of a schema field. */
export interface SchemaArg {
  /** As written: `Int!`, `[ID!]`. */
  type: string
  /** Under the list / non-null wrappers — what coercion keys on. */
  named_type: string
  /** Non-null with no default: a call must pass it. */
  required: boolean
  default_value: unknown
}

/** One field an object or interface type declares. */
export interface SchemaField {
  /** The return type as written: `[Task!]!`, `User`. */
  type: string
  /** Under the list / non-null wrappers. */
  named_type: string
  args: Record<string, SchemaArg>
}

type SchemaTypeKind = 'object' | 'interface' | 'union' | 'scalar' | 'enum' | 'input'

interface SchemaType {
  kind: SchemaTypeKind
  fields: Record<string, SchemaField>
  /** Object and interface types: the interfaces they implement. */
  interfaces: string[]
  /** Union types: their members. */
  members: string[]
}

const KINDS: ReadonlySet<string> = new Set([
  'object',
  'interface',
  'union',
  'scalar',
  'enum',
  'input',
])

/** The scalars every schema has without declaring them. */
const BUILT_IN_SCALARS: ReadonlySet<string> = new Set(['Int', 'Float', 'String', 'Boolean', 'ID'])

const NO_TYPES: ReadonlySet<string> = new Set()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isSchemaArg(value: unknown): value is SchemaArg {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.named_type === 'string' &&
    typeof value.required === 'boolean'
  )
}

function isSchemaField(value: unknown): value is SchemaField {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.named_type === 'string' &&
    isRecord(value.args) &&
    Object.values(value.args).every(isSchemaArg)
  )
}

function isSchemaType(value: unknown): value is SchemaType {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    KINDS.has(value.kind) &&
    isRecord(value.fields) &&
    Object.values(value.fields).every(isSchemaField) &&
    isStringArray(value.interfaces) &&
    isStringArray(value.members)
  )
}

/** The type map the native parser answers with, checked rather than assumed. */
export function isSchemaTypes(value: unknown): value is Record<string, SchemaType> {
  return isRecord(value) && Object.values(value).every(isSchemaType)
}

/** The types of a schema, by name. */
export class GraphQLSchema {
  // Maps, not the parsed objects: a type or a field may be named like a
  // member of `Object.prototype`, and a lookup must not find that member.
  readonly #types = new Map<string, SchemaType>()
  readonly #fields = new Map<string, Map<string, SchemaField>>()
  readonly #possible = new Map<string, ReadonlySet<string>>()

  constructor(types: Record<string, SchemaType>) {
    for (const [name, type] of Object.entries(types)) {
      this.#types.set(name, type)
      this.#fields.set(name, new Map(Object.entries(type.fields)))
    }
    for (const [name, type] of this.#types) {
      if (type.kind === 'object') {
        this.#possible.set(name, new Set([name]))
      } else if (type.kind === 'union') {
        this.#possible.set(name, new Set(type.members))
      } else if (type.kind === 'interface') {
        const implementers = [...this.#types]
          .filter(([, other]) => other.kind === 'object' && other.interfaces.includes(name))
          .map(([other]) => other)
        this.#possible.set(name, new Set(implementers))
      }
    }
  }

  /** Whether `name` is declared (an object, interface, union, scalar, enum or input type). */
  has(name: string): boolean {
    return this.#types.has(name) || BUILT_IN_SCALARS.has(name)
  }

  /** Whether values of `name` have fields: an object, interface or union type. */
  isComposite(name: string): boolean {
    return this.#possible.has(name)
  }

  /** Whether `name` is an object type: the type a value is, not one it may be. */
  isObject(name: string): boolean {
    return this.#types.get(name)?.kind === 'object'
  }

  /**
   * Whether `name` is a scalar the application declared (`scalar JSON`): its
   * values are the application's to shape. A built-in scalar or an enum is a
   * primitive.
   */
  isCustomScalar(name: string): boolean {
    return this.#types.get(name)?.kind === 'scalar' && !BUILT_IN_SCALARS.has(name)
  }

  /** The field `fieldName` of `typeName`, when the type declares it. */
  field(typeName: string, fieldName: string): SchemaField | undefined {
    return this.#fields.get(typeName)?.get(fieldName)
  }

  /**
   * The object types a value of `name` can be: the type itself, the types
   * implementing an interface, the members of a union. Empty for a type that
   * has no fields or does not exist.
   */
  possibleTypes(name: string): ReadonlySet<string> {
    return this.#possible.get(name) ?? NO_TYPES
  }
}

/** A fragment type condition, as the native parser hands it over. */
export interface TypeConditionLink {
  /** Index of the type name. */
  name: number
  /** Index of the enclosing fragment's condition, when there is one. */
  parent: number | null
}

interface ResolvedCondition {
  /** The type named: the one the fragment's fields are looked up on. */
  name: string
  /** The object types that meet this condition and every enclosing one. */
  types: ReadonlySet<string>
  /** Why the condition cannot stand, when it cannot. */
  error?: string
}

/**
 * The type conditions of one parsed operation, resolved against the schema.
 *
 * Fragments are inlined by the parser; a field keeps the index of the
 * condition it was written under (`... on User { name }`). That is what says
 * which type declares the field, and which values it applies to.
 */
export class TypeConditions {
  readonly #resolved: ResolvedCondition[] = []

  constructor(
    schema: GraphQLSchema,
    names: readonly string[],
    links: readonly TypeConditionLink[],
  ) {
    // A link's parent always comes before it: resolved in order, each one
    // once, however many fields point at it.
    for (const link of links) {
      const name = names[link.name]
      const parent = link.parent === null ? undefined : this.#resolved[link.parent]
      if (name === undefined || (link.parent !== null && parent === undefined)) {
        this.#resolved.push({ name: '', types: NO_TYPES, error: 'Unreadable type condition' })
        continue
      }
      if (parent?.error !== undefined) {
        this.#resolved.push({ name, types: NO_TYPES, error: parent.error })
        continue
      }
      if (!schema.has(name)) {
        this.#resolved.push({ name, types: NO_TYPES, error: `Unknown type "${name}".` })
        continue
      }
      if (!schema.isComposite(name)) {
        this.#resolved.push({
          name,
          types: NO_TYPES,
          error: `Fragment cannot condition on non composite type "${name}".`,
        })
        continue
      }
      const own = schema.possibleTypes(name)
      const types = parent === undefined ? own : intersection(own, parent.types)
      if (parent !== undefined && types.size === 0) {
        this.#resolved.push({
          name,
          types,
          error: `Fragment cannot be spread here as objects of type "${parent.name}" can never be of type "${name}".`,
        })
        continue
      }
      this.#resolved.push({ name, types })
    }
  }

  /** The condition a field carries, or undefined for an index the parser did not give. */
  get(index: number): ResolvedCondition | undefined {
    return this.#resolved[index]
  }
}

function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...a].filter((item) => b.has(item)))
}

/** Whether the two sets share a type. */
export function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true
  }
  return false
}

/** A field of a parsed selection, as the projection reads it. */
interface ProjectedField {
  name: string
  alias?: string
  /** Index of the type condition the field was written under. */
  condition?: number
  selection: ProjectedField[]
}

/**
 * Names the object type a value of an abstract type is — what graphql-js
 * calls `resolveType`. Returning nothing leaves the value's own `__typename`
 * to say it.
 */
export type TypeResolver = (value: Record<string, unknown>) => string | undefined

/** What the projection of one operation reads the result with. */
export interface ProjectionContext {
  schema: GraphQLSchema
  conditions: TypeConditions
  typeResolvers: ReadonlyMap<string, TypeResolver>
}

/**
 * Project a resolver's result onto the client's selection, by the schema.
 *
 * `type` is the field's declared type (`[Task!]!`), `coordinate` its name for
 * an error (`Query.tasks`). What goes out:
 * - a list type takes an array, each item projected;
 * - an object, interface or union type takes an object, of which only the
 *   fields that are selected, declared by its type AND its own properties are
 *   copied — never an inherited one, never one the schema does not declare;
 * - a built-in scalar or an enum takes a primitive (or an object whose
 *   `toJSON()` gives one, such as a `Date`): an object is never sent whole
 *   under a `String`;
 * - a scalar the schema declares itself (`scalar JSON`) is sent as it is.
 *
 * Anything else throws `E_GRAPHQL_INVALID_RESULT`: a value that does not fit
 * its type is refused, not guessed at. The mistake is the application's, so
 * the message is for its logs: a client reads it only in debug.
 */
export function projectValue(
  value: unknown,
  type: string,
  selection: readonly ProjectedField[],
  context: ProjectionContext,
  coordinate: string,
): unknown {
  if (value === null || value === undefined) return value
  const bare = type.endsWith('!') ? type.slice(0, -1) : type
  if (bare.startsWith('[') && bare.endsWith(']')) {
    if (!Array.isArray(value)) {
      throw new E_GRAPHQL_INVALID_RESULT([`Expected a list for field "${coordinate}".`])
    }
    const itemType = bare.slice(1, -1)
    return value.map((item) => projectValue(item, itemType, selection, context, coordinate))
  }
  if (context.schema.isComposite(bare)) {
    return projectObject(value, bare, selection, context, coordinate)
  }
  return serializeLeaf(value, bare, context.schema, coordinate)
}

function projectObject(
  value: unknown,
  typeName: string,
  selection: readonly ProjectedField[],
  context: ProjectionContext,
  coordinate: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new E_GRAPHQL_INVALID_RESULT([
      `Expected an object of type "${typeName}" for field "${coordinate}".`,
    ])
  }
  const concrete = concreteType(value, typeName, context, coordinate)
  const out: Record<string, unknown> = {}
  for (const field of selection) {
    if (field.condition !== undefined) {
      // A field written under `... on User` is for the values that are one.
      const condition = context.conditions.get(field.condition)
      if (condition === undefined || !condition.types.has(concrete)) continue
    }
    const key = field.alias ?? field.name
    if (field.name === '__typename') {
      out[key] = concrete
      continue
    }
    const definition = context.schema.field(concrete, field.name)
    if (definition === undefined || !Object.hasOwn(value, field.name)) continue
    out[key] = projectValue(
      value[field.name],
      definition.type,
      field.selection,
      context,
      `${concrete}.${field.name}`,
    )
  }
  return out
}

/** The object type `value` is, when its field is declared with `typeName`. */
function concreteType(
  value: Record<string, unknown>,
  typeName: string,
  context: ProjectionContext,
  coordinate: string,
): string {
  if (context.schema.isObject(typeName)) return typeName
  const named =
    context.typeResolvers.get(typeName)?.(value) ??
    (Object.hasOwn(value, '__typename') ? value.__typename : undefined)
  if (typeof named === 'string' && context.schema.possibleTypes(typeName).has(named)) {
    return named
  }
  throw new E_GRAPHQL_INVALID_RESULT([
    `Abstract type "${typeName}" must resolve to an Object type at runtime for field "${coordinate}". ` +
      `Register engine.resolveType("${typeName}", ...) or return objects carrying "__typename".`,
  ])
}

function isPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function serializeLeaf(
  value: unknown,
  typeName: string,
  schema: GraphQLSchema,
  coordinate: string,
): unknown {
  if (schema.isCustomScalar(typeName)) return value
  if (isPrimitive(value)) return value
  if (typeof value === 'object' && value !== null) {
    const toJSON: unknown = Reflect.get(value, 'toJSON')
    if (typeof toJSON === 'function') {
      const serialized: unknown = Reflect.apply(toJSON, value, [])
      if (serialized === null || isPrimitive(serialized)) return serialized
    }
  }
  throw new E_GRAPHQL_INVALID_RESULT([
    `Field "${coordinate}" of type "${typeName}" cannot represent a value that is not a string, a number or a boolean.`,
  ])
}

/**
 * What reaches a GraphQL resolver's `args`.
 *
 * The document was never checked against the schema, and every request
 * variable was merged into every field's arguments — so a resolver written
 * against its SDL (`User.merge(args)`) received `role`, `isAdmin`, `ownerId`
 * from any client. Now: only the arguments the schema declares for the field,
 * variables only through the `$name` references the operation declares,
 * defaults applied, missing required arguments refused; and a document with
 * several operations runs the one `operationName` names.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine } from '../../src/index.js'

const calls: Array<{ field: string; args: Record<string, unknown> }> = []

class Resolver {
  updateProfile(_parent: unknown, args: Record<string, unknown>) {
    calls.push({ field: 'updateProfile', args })
    return { id: '1', role: 'user' }
  }

  me(_parent: unknown, args: Record<string, unknown>) {
    calls.push({ field: 'me', args })
    return { id: '1', role: 'user' }
  }

  tasks(_parent: unknown, args: Record<string, unknown>) {
    calls.push({ field: 'tasks', args })
    return []
  }
}

const SDL = `
  type Query {
    me: User
    tasks(limit: Int = 10, status: String, ids: [ID!]): [Task]
  }
  type Mutation { updateProfile(name: String, input: ProfileInput, id: ID!): User }
  input ProfileInput { name: String }
  type User { id: ID role: String }
  type Task { id: ID }
`

function makeEngine(): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-args-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, SDL)
  const engine = new GraphQLEngine({ schemaPath })
  engine.resolver('Mutation', 'updateProfile', Resolver, 'updateProfile')
  engine.resolver('Query', 'me', Resolver, 'me')
  engine.resolver('Query', 'tasks', Resolver, 'tasks')
  return engine
}

async function exec(
  body: Record<string, unknown> | string,
): Promise<{ data?: unknown; errors?: Array<{ message: string }> }> {
  calls.length = 0
  const raw: RawRequest = {
    method: 'POST',
    path: '/graphql',
    query: '',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
  const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
  await makeEngine().handle(ctx)
  return JSON.parse(ctx.response.getBody())
}

describe('GraphQLEngine > arguments are the schema-declared ones', () => {
  it('refuses an argument the field does not declare, before any resolver runs', async () => {
    const res = await exec({
      query: 'mutation { updateProfile(id: 1, name: "x", role: "admin", nope: 1) { id role } }',
      variables: { isAdmin: true },
    })
    expect(res.data).toBeUndefined()
    // Reported by argument name, in a stable order.
    expect(res.errors).toEqual([
      { message: 'Unknown argument "nope" on field "Mutation.updateProfile".' },
      { message: 'Unknown argument "role" on field "Mutation.updateProfile".' },
    ])
    expect(calls).toEqual([])
  })

  it('never merges request variables into the arguments', async () => {
    const res = await exec({
      query: 'mutation M($n: String) { updateProfile(id: 1, name: $n) { id } }',
      variables: { n: 'x', isAdmin: true, role: 'admin' },
    })
    expect(res.errors).toBeUndefined()
    expect(calls).toEqual([{ field: 'updateProfile', args: { id: '1', name: 'x' } }])
  })

  it('refuses a variable the operation does not declare', async () => {
    const res = await exec({
      query: 'mutation { updateProfile(id: 1, name: $role) { id } }',
      variables: { role: 'admin' },
    })
    expect(res.errors).toEqual([{ message: 'Variable "$role" is not defined.' }])
    expect(calls).toEqual([])
  })

  it('treats a string literal starting with "$" as a string', async () => {
    await exec({
      query: 'mutation M($role: String) { updateProfile(id: 1, name: "$role") { id } }',
      variables: { role: 'admin' },
    })
    expect(calls[0]?.args).toEqual({ id: '1', name: '$role' })
  })

  it('refuses a missing required argument and applies a declared default', async () => {
    const missing = await exec({ query: 'mutation { updateProfile(name: "x") { id } }' })
    expect(missing.errors).toEqual([
      {
        message:
          'Argument "Mutation.updateProfile(id:)" of type "ID!" is required, but it was not provided.',
      },
    ])
    await exec({ query: '{ tasks { id } }' })
    expect(calls).toEqual([{ field: 'tasks', args: { limit: 10 } }])
  })

  it('refuses an argument on a field that declares none, and a field the type lacks', async () => {
    const extra = await exec({ query: '{ me(asUser: 2) { id } }' })
    expect(extra.errors).toEqual([{ message: 'Unknown argument "asUser" on field "Query.me".' }])
    const unknown = await exec({ query: '{ admin { id } }' })
    expect(unknown.errors).toEqual([{ message: 'Cannot query field "admin" on type "Query".' }])
  })

  it('substitutes variables nested in lists and objects', async () => {
    await exec({
      query: 'query Q($a: ID, $b: ID) { tasks(ids: [$a, $b, "3"]) { id } }',
      variables: { a: 1, b: '2' },
    })
    expect(calls[0]?.args).toEqual({ limit: 10, ids: ['1', '2', '3'] })
  })

  it('checks the operation variables: required, non-null, default', async () => {
    const missing = await exec({ query: 'query Q($s: String!) { tasks(status: $s) { id } }' })
    expect(missing.errors).toEqual([
      { message: 'Variable "$s" of required type "String!" was not provided.' },
    ])
    const nulled = await exec({
      query: 'query Q($s: String!) { tasks(status: $s) { id } }',
      variables: { s: null },
    })
    expect(nulled.errors).toEqual([
      { message: 'Variable "$s" of non-null type "String!" must not be null.' },
    ])
    await exec({ query: 'query Q($s: String = "open") { tasks(status: $s) { id } }' })
    expect(calls[0]?.args).toEqual({ limit: 10, status: 'open' })
  })
})

describe('GraphQLEngine > operationName', () => {
  const document = 'query Mine { me { id } } mutation Change { updateProfile(id: 1) { id } }'

  it('runs the named operation', async () => {
    const res = await exec({ query: document, operationName: 'Mine' })
    expect(res.errors).toBeUndefined()
    expect(calls.map((call) => call.field)).toEqual(['me'])
  })

  it('refuses an ambiguous document and an unknown name', async () => {
    const ambiguous = await exec({ query: document })
    expect(ambiguous.errors).toEqual([
      { message: 'Must provide operation name if query contains multiple operations.' },
    ])
    const unknown = await exec({ query: document, operationName: 'Other' })
    expect(unknown.errors).toEqual([{ message: 'Unknown operation named "Other".' }])
    expect(calls).toEqual([])
  })
})

describe('GraphQLEngine > prototype keys in request data', () => {
  it('drops __proto__ from variables before they reach a resolver', async () => {
    await exec(
      '{"query":"mutation M($i: ProfileInput) { updateProfile(id: 1, input: $i) { id } }","variables":{"i":{"name":"x","__proto__":{"isAdmin":true}}}}',
    )
    const input = calls[0]?.args.input
    expect(input).toEqual({ name: 'x' })
    expect(Object.hasOwn(Object(input), '__proto__')).toBe(false)
    expect(Reflect.get(Object.assign({}, input), 'isAdmin')).toBeUndefined()
  })

  it('drops __proto__ from an object literal in the query', async () => {
    await exec({
      query:
        'mutation { updateProfile(id: 1, input: { name: "x", __proto__: { isAdmin: true } }) { id } }',
    })
    const input = calls[0]?.args.input
    expect(Object.hasOwn(Object(input), '__proto__')).toBe(false)
    expect(Reflect.get(Object.assign({}, input), 'isAdmin')).toBeUndefined()
  })
})

/**
 * Every selection is checked against the schema, at every depth, before any
 * resolver runs — the graphql-js rules FieldsOnCorrectType and ScalarLeafs,
 * with their messages. The schema is the published contract: what it does not
 * declare cannot be read, whatever the resolver returns.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../src/bootstrap/hyper-server.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine, GraphQLProvider, Ignitor } from '../../src/index.js'

// What an ORM hands back: every column as an own property, and a serializer
// that hides the secret ones.
class User {
  id = 1
  name = 'Ada'
  passwordHash = '$argon2id$v=19$m=65536$secret'
  rememberToken = 'tok_live_123'
  toJSON(): unknown {
    return { id: this.id, name: this.name }
  }
}
class Task {
  id = 10
  title = 'Ship it'
  internalNote = 'customer is in arrears'
  owner = new User()
}

let resolverRuns = 0
class TaskResolver {
  tasks(): Task[] {
    resolverRuns += 1
    return [new Task()]
  }
  me(): User {
    resolverRuns += 1
    return new User()
  }
  rename(): Task {
    resolverRuns += 1
    return new Task()
  }
}

const SDL = `
  type Query { tasks(first: Int): [Task!]! me: User }
  type Mutation { rename(id: ID!): Task }
  type Task { id: ID! title: String owner(full: Boolean): User }
  type User { id: ID! name: String }
  interface Node { id: ID! }
  scalar Date
`

function writeSchema(sdl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-selection-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, sdl)
  return schemaPath
}

function register(engine: GraphQLEngine): GraphQLEngine {
  engine.resolver('Query', 'tasks', TaskResolver, 'tasks')
  engine.resolver('Query', 'me', TaskResolver, 'me')
  engine.resolver('Mutation', 'rename', TaskResolver, 'rename')
  return engine
}

interface Reply {
  data?: Record<string, unknown>
  errors?: Array<{ message: string }>
}

async function exec(engine: GraphQLEngine, query: string): Promise<Reply> {
  const raw: RawRequest = {
    method: 'POST',
    path: '/graphql',
    query: '',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  }
  const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
  await engine.handle(ctx)
  return JSON.parse(ctx.response.getBody())
}

describe('graphql > nested selections against the schema, over real HTTP', () => {
  let ignitor: Ignitor
  let port = 0

  beforeAll(async () => {
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      .configure('graphql', { schemaPath: writeSchema(SDL) })
      .provider((app) => new GraphQLProvider(app))
      .httpServer()
      .start()
    register(await ignitor.getApp().container.make<GraphQLEngine>('graphql'))
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
  })

  async function post(query: string): Promise<{ status: number; body: Reply; text: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const text = await res.text()
    return { status: res.status, body: JSON.parse(text), text }
  }

  it('refuses a nested field its type does not declare, and runs no resolver', async () => {
    resolverRuns = 0
    const { body, text } = await post(
      '{ tasks { id internalNote owner { id passwordHash rememberToken } } }',
    )
    expect(body.data).toBeUndefined()
    expect(body.errors).toEqual([
      { message: 'Cannot query field "internalNote" on type "Task".' },
      { message: 'Cannot query field "passwordHash" on type "User".' },
      { message: 'Cannot query field "rememberToken" on type "User".' },
    ])
    expect(resolverRuns).toBe(0)
    expect(text).not.toContain('argon2id')
    expect(text).not.toContain('tok_live_123')
    expect(text).not.toContain('arrears')
  })

  it('refuses an object field with no sub-selection instead of sending it whole', async () => {
    resolverRuns = 0
    const list = await post('{ tasks }')
    expect(list.body).toEqual({
      errors: [
        {
          message:
            'Field "tasks" of type "[Task!]!" must have a selection of subfields. Did you mean "tasks { ... }"?',
        },
      ],
    })
    const nested = await post('{ me tasks { owner } }')
    expect(nested.body.data).toBeUndefined()
    expect(nested.body.errors?.map((error) => error.message)).toEqual([
      'Field "me" of type "User" must have a selection of subfields. Did you mean "me { ... }"?',
      'Field "owner" of type "User" must have a selection of subfields. Did you mean "owner { ... }"?',
    ])
    expect(resolverRuns).toBe(0)
    expect(list.text + nested.text).not.toContain('argon2id')
  })

  it('answers the declared fields of a rich object, and only those', async () => {
    const { status, body, text } = await post('{ tasks { id title owner { id name } } }')
    expect(status).toBe(200)
    expect(body).toEqual({
      data: { tasks: [{ id: 10, title: 'Ship it', owner: { id: 1, name: 'Ada' } }] },
    })
    expect(text).not.toContain('argon2id')
  })
})

describe('graphql > selection rules at every depth', () => {
  it('refuses a selection on a field that has no subfields', async () => {
    const reply = await exec(
      register(new GraphQLEngine({ schemaPath: writeSchema(SDL) })),
      '{ tasks { id { x } title { length } } }',
    )
    expect(reply.errors).toEqual([
      { message: 'Field "id" must not have a selection since type "ID!" has no subfields.' },
      { message: 'Field "title" must not have a selection since type "String" has no subfields.' },
    ])
  })

  it('checks the selection a fragment brings, on the type it conditions on', async () => {
    const engine = register(new GraphQLEngine({ schemaPath: writeSchema(SDL) }))
    const named = await exec(
      engine,
      '{ tasks { ...T } } fragment T on Task { id owner { ...U } } fragment U on User { passwordHash }',
    )
    expect(named.errors).toEqual([{ message: 'Cannot query field "passwordHash" on type "User".' }])
    const inline = await exec(
      engine,
      '{ me { ... on User { rememberToken } ... { passwordHash } } }',
    )
    expect(inline.errors).toEqual([
      { message: 'Cannot query field "rememberToken" on type "User".' },
      { message: 'Cannot query field "passwordHash" on type "User".' },
    ])
  })

  it('refuses a fragment on a type that does not exist, has no fields, or cannot be there', async () => {
    const engine = register(new GraphQLEngine({ schemaPath: writeSchema(SDL) }))
    expect((await exec(engine, '{ me { ... on Admin { id } } }')).errors).toEqual([
      { message: 'Unknown type "Admin".' },
    ])
    expect((await exec(engine, '{ me { ... on Date { id } } }')).errors).toEqual([
      { message: 'Fragment cannot condition on non composite type "Date".' },
    ])
    // A User is never a Task: the fragment cannot bring Task's fields in.
    expect((await exec(engine, '{ me { ... on Task { title } } }')).errors).toEqual([
      {
        message:
          'Fragment cannot be spread here as objects of type "User" can never be of type "Task".',
      },
    ])
    expect(
      (await exec(engine, '{ tasks { ... on Task { ... on User { name } } } }')).errors,
    ).toEqual([
      {
        message:
          'Fragment cannot be spread here as objects of type "Task" can never be of type "User".',
      },
    ])
    // No object type implements Node here: nothing can be one.
    expect((await exec(engine, '{ me { ... on Node { id } } }')).errors).toEqual([
      {
        message:
          'Fragment cannot be spread here as objects of type "User" can never be of type "Node".',
      },
    ])
  })

  it('checks the arguments of a nested field as it does at the root', async () => {
    const engine = register(new GraphQLEngine({ schemaPath: writeSchema(SDL) }))
    const reply = await exec(
      engine,
      '{ tasks(first: 1) { owner(full: true, admin: true) { id } id(raw: 1) } }',
    )
    expect(reply.errors).toEqual([
      { message: 'Unknown argument "admin" on field "Task.owner".' },
      { message: 'Unknown argument "raw" on field "Task.id".' },
    ])
    const fine = await exec(engine, '{ tasks(first: 1) { owner(full: true) { id } } }')
    expect(fine).toEqual({ data: { tasks: [{ owner: { id: 1 } }] } })
  })

  it('refuses a mutation whose selection is invalid before it runs', async () => {
    resolverRuns = 0
    const engine = register(new GraphQLEngine({ schemaPath: writeSchema(SDL) }))
    const reply = await exec(engine, 'mutation { rename(id: "1") { id internalNote } }')
    expect(reply).toEqual({
      errors: [{ message: 'Cannot query field "internalNote" on type "Task".' }],
    })
    expect(resolverRuns).toBe(0)
  })

  it('does not take a member of Object.prototype for a declared field or type', async () => {
    const engine = register(new GraphQLEngine({ schemaPath: writeSchema(SDL) }))
    const reply = await exec(engine, '{ me { constructor toString hasOwnProperty } }')
    expect(reply.errors).toEqual([
      { message: 'Cannot query field "constructor" on type "User".' },
      { message: 'Cannot query field "toString" on type "User".' },
      { message: 'Cannot query field "hasOwnProperty" on type "User".' },
    ])
    expect((await exec(engine, '{ me { ... on constructor { id } } }')).errors).toEqual([
      { message: 'Unknown type "constructor".' },
    ])
  })
})

describe('graphql > a schema the engine cannot read types from', () => {
  it('refuses every query when the schema names a type it does not declare', async () => {
    resolverRuns = 0
    // `Usr` is a typo: the engine cannot tell whether `owner` is an object to
    // read field by field or a scalar to send as it is.
    const engine = new GraphQLEngine({
      schemaPath: writeSchema('type Query { me: Usr } type User { id: ID! }'),
    })
    engine.resolver('Query', 'me', TaskResolver, 'me')
    const reply = await exec(engine, '{ me }')
    expect(reply).toEqual({ errors: [{ message: 'GraphQL schema could not be read' }] })
    expect(resolverRuns).toBe(0)
  })
})

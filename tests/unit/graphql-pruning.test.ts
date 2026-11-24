/**
 * What goes out of a resolver's result: the fields the client selected AND
 * the value's type declares, read as own properties — the projection that
 * stops a resolver returning a rich object (an ORM entity with
 * `passwordHash`) from leaking what the schema does not publish.
 *
 * Everything runs through the engine and the native parser, with a real SDL.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine } from '../../src/index.js'

const SDL = `
  scalar JSON
  enum Status { OPEN DONE }
  interface Node { id: ID! }
  type User implements Node { id: ID! name: String email: String joined: String }
  type Task implements Node { id: ID! title: String status: Status owner: User meta: JSON tags: [String!] }
  union Hit = User | Task
  type Query {
    user: User
    users: [User!]!
    task: Task
    node: Node
    hits: [Hit!]!
    count: Int
    label: String
  }
`

/** What `Query.<field>` returns in a test: set, then queried. */
const returns: Record<string, unknown> = {}

class Resolvers {
  user(): unknown {
    return returns.user
  }
  users(): unknown {
    return returns.users
  }
  task(): unknown {
    return returns.task
  }
  node(): unknown {
    return returns.node
  }
  hits(): unknown {
    return returns.hits
  }
  count(): unknown {
    return returns.count
  }
  label(): unknown {
    return returns.label
  }
}

function makeEngine(): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-projection-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, SDL)
  // `debug` so a refused result reads as itself rather than "Internal server error".
  const engine = new GraphQLEngine({ schemaPath, debug: true })
  for (const field of ['user', 'users', 'task', 'node', 'hits', 'count', 'label']) {
    engine.resolver('Query', field, Resolvers, field)
  }
  return engine
}

interface Reply {
  data?: Record<string, unknown>
  errors?: Array<{ message: string; path?: string[] }>
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

describe('graphql > projection of a resolver result', () => {
  it('drops what the client did not select from a rich object', async () => {
    returns.user = { id: '1', email: 'a@b.com', passwordHash: 'secret', isAdmin: true }
    const reply = await exec(makeEngine(), '{ user { id email } }')
    expect(reply).toEqual({ data: { user: { id: '1', email: 'a@b.com' } } })
  })

  it('projects nested objects and lists by their own types', async () => {
    returns.task = {
      id: '10',
      title: 'Ship it',
      internalNote: 'leak',
      owner: { id: '1', name: 'Ada', ssn: '999-99-9999' },
      tags: ['a', 'b'],
    }
    returns.users = [
      { id: '1', token: 'x' },
      { id: '2', token: 'y' },
    ]
    const reply = await exec(makeEngine(), '{ task { id owner { name } tags } users { id } }')
    expect(reply).toEqual({
      data: {
        task: { id: '10', owner: { name: 'Ada' }, tags: ['a', 'b'] },
        users: [{ id: '1' }, { id: '2' }],
      },
    })
  })

  it('keys the result by alias and reads the real field', async () => {
    returns.user = { id: '7', secret: 's' }
    const reply = await exec(makeEngine(), '{ me: user { uid: id } }')
    expect(reply.data).toEqual({ me: { uid: '7' } })
  })

  it('does not invent a field the resolver did not return', async () => {
    returns.user = { id: '1' }
    const reply = await exec(makeEngine(), '{ user { id name } }')
    expect(reply.data).toEqual({ user: { id: '1' } })
  })

  it('reads own properties only, never what the object inherits', async () => {
    class Entity {
      id = '1'
      // On the prototype: not a column of this row.
      get name(): string {
        return 'from the prototype'
      }
    }
    const withPrototype: Record<string, unknown> = Object.create({ email: 'inherited@x.test' })
    withPrototype.id = '2'
    returns.users = [new Entity(), withPrototype]
    const reply = await exec(makeEngine(), '{ users { id name email } }')
    expect(reply.data).toEqual({ users: [{ id: '1' }, { id: '2' }] })
  })

  it('reads a declared field past the object serializer, and nothing else', async () => {
    // What an ORM hands back: every column an own property, `toJSON` hiding
    // some. The schema decides, not the serializer: `email` is declared and
    // goes out, `passwordHash` is not and cannot even be selected.
    class User {
      id = '1'
      email = 'ada@x.test'
      passwordHash = '$argon2id$secret'
      toJSON(): unknown {
        return { id: this.id }
      }
    }
    returns.user = new User()
    const engine = makeEngine()
    expect((await exec(engine, '{ user { id email } }')).data).toEqual({
      user: { id: '1', email: 'ada@x.test' },
    })
    const refused = await exec(engine, '{ user { id passwordHash } }')
    expect(refused.data).toBeUndefined()
    expect(JSON.stringify(refused)).not.toContain('argon2id')
  })

  it('passes null through at any depth', async () => {
    returns.task = { id: '1', owner: null, tags: null }
    returns.user = null
    const reply = await exec(makeEngine(), '{ task { id owner { id } tags } user { id } }')
    expect(reply.data).toEqual({ task: { id: '1', owner: null, tags: null }, user: null })
  })
})

describe('graphql > a value that does not fit its declared type is refused', () => {
  it('refuses an object where the schema says String, instead of sending it whole', async () => {
    returns.label = { id: 1, passwordHash: 'secret' }
    returns.user = { id: '1', name: { first: 'Ada', passwordHash: 'secret' } }
    const reply = await exec(makeEngine(), '{ label user { name } }')
    expect(reply.data).toBeUndefined()
    expect(reply.errors).toEqual([
      {
        message:
          'Field "Query.label" of type "String" cannot represent a value that is not a string, a number or a boolean.',
        path: ['label'],
      },
      {
        message:
          'Field "User.name" of type "String" cannot represent a value that is not a string, a number or a boolean.',
        path: ['user'],
      },
    ])
    expect(JSON.stringify(reply)).not.toContain('secret')
  })

  it('serializes an object that turns itself into a primitive, such as a Date', async () => {
    returns.user = { id: '1', joined: new Date('2026-01-02T03:04:05.000Z') }
    const reply = await exec(makeEngine(), '{ user { joined } }')
    expect(reply.data).toEqual({ user: { joined: '2026-01-02T03:04:05.000Z' } })
  })

  it('refuses an object whose toJSON() is still an object under a built-in scalar', async () => {
    returns.label = { toJSON: () => ({ passwordHash: 'secret' }) }
    const reply = await exec(makeEngine(), '{ label }')
    expect(reply.data).toBeUndefined()
    expect(JSON.stringify(reply)).not.toContain('secret')
  })

  it('refuses a single value under a list type and a list under an object type', async () => {
    returns.users = { id: '1' }
    returns.user = [{ id: '1' }]
    returns.count = 3
    const reply = await exec(makeEngine(), '{ users { id } user { id } count }')
    expect(reply.data).toEqual({ count: 3 })
    expect(reply.errors).toEqual([
      { message: 'Expected a list for field "Query.users".', path: ['users'] },
      { message: 'Expected an object of type "User" for field "Query.user".', path: ['user'] },
    ])
  })

  it('refuses a primitive where an object is declared', async () => {
    returns.task = { id: '1', owner: 'ada' }
    const reply = await exec(makeEngine(), '{ task { owner { id } } }')
    expect(reply.errors).toEqual([
      { message: 'Expected an object of type "User" for field "Task.owner".', path: ['task'] },
    ])
  })

  it('sends a scalar the schema declares itself as the application shaped it', async () => {
    returns.task = { id: '1', meta: { color: 'red', sizes: [1, 2] }, status: 'OPEN' }
    const reply = await exec(makeEngine(), '{ task { meta status } }')
    expect(reply.data).toEqual({ task: { meta: { color: 'red', sizes: [1, 2] }, status: 'OPEN' } })
  })

  it('hides the reason from the client outside debug, and logs it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-gql-projection-'))
    const schemaPath = join(dir, 'schema.graphql')
    writeFileSync(schemaPath, SDL)
    const engine = new GraphQLEngine({ schemaPath, debug: false })
    engine.resolver('Query', 'label', Resolvers, 'label')
    returns.label = { passwordHash: 'secret' }
    const reply = await exec(engine, '{ label }')
    expect(reply.errors).toEqual([{ message: 'Internal server error', path: ['label'] }])
  })
})

describe('graphql > interfaces and unions', () => {
  it('reads a value by the object type its __typename names', async () => {
    returns.node = { __typename: 'User', id: '1', name: 'Ada', title: 'not a user field' }
    const reply = await exec(
      makeEngine(),
      '{ node { __typename id ... on User { name } ... on Task { title } } }',
    )
    expect(reply.data).toEqual({ node: { __typename: 'User', id: '1', name: 'Ada' } })
  })

  it('applies each fragment to the values of its type only', async () => {
    returns.hits = [
      { __typename: 'User', id: '1', name: 'Ada', title: 'x' },
      { __typename: 'Task', id: '2', name: 'x', title: 'Ship it' },
    ]
    const reply = await exec(
      makeEngine(),
      '{ hits { ... on Node { id } ...U ... on Task { title } } } fragment U on User { name }',
    )
    expect(reply.data).toEqual({
      hits: [
        { id: '1', name: 'Ada' },
        { id: '2', title: 'Ship it' },
      ],
    })
  })

  it('applies a nested fragment only where every enclosing condition holds', async () => {
    returns.hits = [
      { __typename: 'User', id: '1' },
      { __typename: 'Task', id: '2' },
    ]
    // `id` is asked of the Users that are Nodes: a Task is a Node too, and
    // gets nothing.
    const reply = await exec(makeEngine(), '{ hits { ... on User { ... on Node { id } } } }')
    expect(reply.data).toEqual({ hits: [{ id: '1' }, {}] })
  })

  it('asks the registered type resolver before __typename', async () => {
    class UserRow {
      id = '1'
      name = 'Ada'
    }
    class TaskRow {
      id = '2'
      title = 'Ship it'
    }
    returns.hits = [new UserRow(), new TaskRow()]
    const engine = makeEngine()
    engine.resolveType('Hit', (value) => (value instanceof UserRow ? 'User' : 'Task'))
    const reply = await exec(
      engine,
      '{ hits { __typename ... on User { name } ... on Task { title } } }',
    )
    expect(reply.data).toEqual({
      hits: [
        { __typename: 'User', name: 'Ada' },
        { __typename: 'Task', title: 'Ship it' },
      ],
    })
  })

  it('refuses a value whose object type is unknown or not one of the possible types', async () => {
    const engine = makeEngine()
    returns.node = { id: '1', name: 'Ada' }
    const untyped = await exec(engine, '{ node { id } }')
    expect(untyped.data).toBeUndefined()
    expect(untyped.errors?.[0]?.message).toContain(
      'Abstract type "Node" must resolve to an Object type at runtime for field "Query.node".',
    )
    returns.node = { __typename: 'Query', id: '1' }
    expect((await exec(engine, '{ node { id } }')).data).toBeUndefined()
    // An inherited `__typename` names nothing.
    returns.node = Object.assign(Object.create({ __typename: 'User' }), { id: '1' })
    expect((await exec(engine, '{ node { id } }')).data).toBeUndefined()
  })

  it('answers __typename for an object type and at the root', async () => {
    returns.user = { id: '1' }
    const reply = await exec(makeEngine(), '{ __typename user { __typename id } }')
    expect(reply.data).toEqual({ __typename: 'Query', user: { __typename: 'User', id: '1' } })
  })
})

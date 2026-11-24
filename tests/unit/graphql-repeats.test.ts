/**
 * One request runs every alias of a root field, so a limiter in front of the
 * endpoint counts one request for as many attempts as the query has fields.
 * Two bounds: how many times one root field may be selected per request
 * (once for a mutation by default), and named middleware on a resolver, run
 * once per call.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import type { GraphQLConfig, ResolverOptions } from '../../src/index.js'
import { Container, GraphQLEngine, MiddlewareRegistry } from '../../src/index.js'

let attempts = 0
class Auth {
  login(_: unknown, args: { password: string }): boolean {
    attempts += 1
    return args.password === 'hunter2'
  }
  user(_: unknown, args: { id: string }): { id: string } {
    attempts += 1
    return { id: args.id }
  }
}

const SDL = `
  type Query { user(id: ID!): User ping: Boolean }
  type Mutation { login(email: String!, password: String!): Boolean ping: Boolean }
  type User { id: ID! }
`

function makeEngine(
  config: Partial<GraphQLConfig> = {},
  loginOptions?: ResolverOptions,
): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-repeats-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, SDL)
  const engine = new GraphQLEngine({ schemaPath, ...config })
  engine.resolver('Mutation', 'login', Auth, 'login', loginOptions)
  engine.resolver('Query', 'user', Auth, 'user')
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

const logins = (n: number): string =>
  Array.from({ length: n }, (_, i) => `a${i}: login(email: "a@b.c", password: "p${i}")`).join(' ')
const users = (n: number): string =>
  Array.from({ length: n }, (_, i) => `u${i}: user(id: "${i}") { id }`).join(' ')

describe('graphql > how many times one root field runs per request', () => {
  it('refuses a mutation repeated under aliases, before any of them runs', async () => {
    attempts = 0
    const reply = await exec(makeEngine(), `mutation { ${logins(3)} }`)
    expect(reply).toEqual({
      errors: [
        {
          message: 'Field "Mutation.login" is selected 3 times in this request; at most 1 allowed.',
        },
      ],
    })
    expect(attempts).toBe(0)
  })

  it('runs a mutation selected once', async () => {
    attempts = 0
    const reply = await exec(makeEngine(), `mutation { ${logins(1)} }`)
    expect(reply).toEqual({ data: { a0: false } })
    expect(attempts).toBe(1)
  })

  it('counts a field repeated through a fragment', async () => {
    attempts = 0
    const reply = await exec(
      makeEngine(),
      `mutation { ...L ${logins(1)} } fragment L on Mutation { b: login(email: "a@b.c", password: "x") }`,
    )
    expect(reply.data).toBeUndefined()
    expect(reply.errors?.[0]?.message).toContain('is selected 2 times')
    expect(attempts).toBe(0)
  })

  it('lets a query field be selected up to maxFieldRepeats times', async () => {
    attempts = 0
    const engine = makeEngine()
    const within = await exec(engine, `{ ${users(10)} }`)
    expect(Object.keys(within.data ?? {})).toHaveLength(10)
    expect(attempts).toBe(10)
    attempts = 0
    const over = await exec(engine, `{ ${users(11)} }`)
    expect(over).toEqual({
      errors: [
        {
          message: 'Field "Query.user" is selected 11 times in this request; at most 10 allowed.',
        },
      ],
    })
    expect(attempts).toBe(0)
  })

  it('counts each field on its own', async () => {
    attempts = 0
    const reply = await exec(
      makeEngine({ maxFieldRepeats: 2 }),
      `{ ${users(2)} a: __typename b: __typename }`,
    )
    expect(reply.errors).toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('takes the limits from the configuration, and from the resolver first', async () => {
    attempts = 0
    const batched = makeEngine({ maxMutationRepeats: 3 })
    expect((await exec(batched, `mutation { ${logins(3)} }`)).errors).toBeUndefined()
    expect(attempts).toBe(3)
    expect((await exec(batched, `mutation { ${logins(4)} }`)).data).toBeUndefined()

    // The resolver's own bound wins over the engine's, either way.
    attempts = 0
    const perResolver = makeEngine({ maxMutationRepeats: 50 }, { maxRepeats: 2 })
    expect((await exec(perResolver, `mutation { ${logins(3)} }`)).data).toBeUndefined()
    expect(attempts).toBe(0)
    expect((await exec(perResolver, `mutation { ${logins(2)} }`)).errors).toBeUndefined()
    expect(attempts).toBe(2)
  })
})

describe('graphql > named middleware on a resolver', () => {
  function withRegistry(engine: GraphQLEngine): {
    registry: MiddlewareRegistry
    counted: () => number
  } {
    const container = new Container()
    const registry = new MiddlewareRegistry()
    let counted = 0
    registry.register('loginThrottle', async (_ctx, next) => {
      counted += 1
      if (counted > 2) throw Object.assign(new Error('Too many requests'), { status: 429 })
      await next()
    })
    container.singleton('middleware', () => registry)
    engine.useContainer(container)
    return { registry, counted: () => counted }
  }

  it('runs once per call of the resolver, so a throttle counts attempts', async () => {
    attempts = 0
    const engine = makeEngine({ maxMutationRepeats: 5 }, { middleware: ['loginThrottle'] })
    const { counted } = withRegistry(engine)
    const reply = await exec(engine, `mutation { ${logins(5)} }`)
    // The throttle saw every alias and stopped the resolver after two.
    expect(counted()).toBe(5)
    expect(attempts).toBe(2)
    expect(reply.data).toEqual({ a0: false, a1: false })
    expect(reply.errors).toEqual([
      { message: 'Too many requests', path: ['login'] },
      { message: 'Too many requests', path: ['login'] },
      { message: 'Too many requests', path: ['login'] },
    ])
  })

  it('does not run a resolver that carries none', async () => {
    attempts = 0
    const engine = makeEngine({}, { middleware: ['loginThrottle'] })
    const { counted } = withRegistry(engine)
    await exec(engine, '{ user(id: "1") { id } }')
    expect(counted()).toBe(0)
    expect(attempts).toBe(1)
  })

  it('does not run the resolver when a middleware name is unknown or no registry is wired', async () => {
    attempts = 0
    const unknown = makeEngine({ debug: true }, { middleware: ['nope'] })
    withRegistry(unknown)
    const first = await exec(unknown, `mutation { ${logins(1)} }`)
    expect(first.data).toBeUndefined()
    expect(first.errors?.[0]?.message).toBe("Named middleware 'nope' is not registered.")

    const unwired = makeEngine({ debug: true }, { middleware: ['loginThrottle'] })
    const second = await exec(unwired, `mutation { ${logins(1)} }`)
    expect(second.data).toBeUndefined()
    expect(second.errors?.[0]?.message).toContain('no middleware registry is wired')
    expect(attempts).toBe(0)
  })
})

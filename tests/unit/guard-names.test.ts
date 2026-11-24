/**
 * `.guard('jwt')` restricts which guards may vouch for a request — on routes,
 * RPC methods and GraphQL resolvers alike.
 *
 * The three gates only checked `ctx.auth.isAuthenticated`, so a request
 * authenticated by the session guard ran a route declared `.guard('jwt')`:
 * a cross-site form post riding the session cookie reached an endpoint meant
 * to be bearer-token only. AdonisJS `middleware.auth({ guards })` calls
 * `ctx.auth.authenticateUsing(guards)`; the gates now do the same, accept a
 * request already authenticated by one of the named guards, and fail closed
 * on an auth state that cannot tell which guard authenticated it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GraphQLEngine } from '../../src/graphql/GraphQLEngine.js'
import { E_UNAUTHORIZED_ACCESS } from '../../src/http/Exception.js'
import { type AuthState, HttpContext } from '../../src/http/HttpContext.js'
import { authenticatedByGuards } from '../../src/http/permissions.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'

interface Scenario {
  /** Guard that already authenticated the request, if any. */
  via?: string
  /** Leave `authenticatedViaGuard` out: a host that does not report it. */
  anonymousGuard?: boolean
  /** Guards `authenticateUsing` can authenticate with; absent = no such method. */
  canAuthenticate?: string[]
  /** `authenticateUsing` crashes (status 500) instead of answering. */
  crashes?: boolean
}

const attempts: string[][] = []

function authFor(scenario: Scenario): AuthState {
  let via = scenario.via
  const state: AuthState = {
    get isAuthenticated() {
      return via !== undefined
    },
    get user() {
      return via === undefined ? undefined : { id: 'u1' }
    },
  }
  // Defined, not spread: a spread would copy the getter's value once.
  if (!scenario.anonymousGuard) {
    Object.defineProperty(state, 'authenticatedViaGuard', { get: () => via })
  }
  if (scenario.canAuthenticate !== undefined) {
    const accepted = scenario.canAuthenticate
    state.authenticateUsing = async (guards = []) => {
      attempts.push(guards)
      if (scenario.crashes) {
        throw Object.assign(new Error('token store down'), { status: 500 })
      }
      const match = guards.find((guard) => accepted.includes(guard))
      if (match === undefined) {
        throw Object.assign(new Error('Unauthorized access'), {
          status: 401,
          code: 'E_UNAUTHORIZED_ACCESS',
        })
      }
      via = match
      return { id: 'u1' }
    }
  }
  return state
}

function makeCtx(body = ''): HttpContext {
  return new HttpContext(
    'req-1',
    { method: 'POST', path: '/', query: '', headers: { 'content-type': 'application/json' }, body },
    {},
    { pattern: '/', middleware: [] },
  )
}

const cases: Array<[label: string, scenario: Scenario, allowed: boolean]> = [
  ['authenticated by the session guard only', { via: 'web' }, false],
  ['authenticated by the named guard', { via: 'jwt' }, true],
  [
    'authenticated, by a guard the auth state does not report',
    { via: 'jwt', anonymousGuard: true },
    false,
  ],
  ['a session request the named guard rejects', { via: 'web', canAuthenticate: ['web'] }, false],
  ['a guest the named guard authenticates', { canAuthenticate: ['jwt'] }, true],
  ['a guest', {}, false],
]

describe('route .guard() gate', () => {
  for (const [label, scenario, allowed] of cases) {
    it(`${allowed ? 'admits' : 'refuses (401)'} ${label}`, async () => {
      let ran = false
      const chain = new MiddlewareRegistry().buildChain(
        [],
        [],
        async () => {
          ran = true
        },
        { guards: [['jwt']] },
      )
      const ctx = makeCtx()
      ctx.auth = authFor(scenario)
      const outcome = await Promise.resolve(chain(ctx, async () => {})).then(
        () => 'ran',
        (error: unknown) => error,
      )
      expect(ran).toBe(allowed)
      if (allowed) expect(outcome).toBe('ran')
      else expect(Reflect.get(Object(outcome), 'status')).toBe(401)
    })
  }

  it('authenticates with the named guards, as authenticateUsing(guards)', async () => {
    attempts.length = 0
    const chain = new MiddlewareRegistry().buildChain([], [], async () => {}, {
      guards: [['jwt', 'api']],
    })
    const ctx = makeCtx()
    ctx.auth = authFor({ via: 'web', canAuthenticate: ['api'] })
    await chain(ctx, async () => {})
    expect(attempts).toEqual([['jwt', 'api']])
    expect(ctx.auth.authenticatedViaGuard).toBe('api')
  })

  it('refuses with E_UNAUTHORIZED_ACCESS when no authenticator is there to ask', async () => {
    const chain = new MiddlewareRegistry().buildChain([], [], async () => {}, { guards: [['jwt']] })
    const ctx = makeCtx()
    ctx.auth = authFor({ via: 'web' })
    const refusal = chain(ctx, async () => {})
    await expect(refusal).rejects.toBeInstanceOf(E_UNAUTHORIZED_ACCESS)
    // The code, status and message @c9up/warden raises for the same refusal.
    await expect(refusal).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED_ACCESS',
      status: 401,
      message: 'Unauthorized access',
    })
  })
})

describe('RPC method guard gate', () => {
  for (const [label, scenario, allowed] of cases) {
    it(`${allowed ? 'runs' : 'refuses'} the call for ${label}`, async () => {
      let ran = false
      const rpc = new RpcRouter()
      rpc
        .method('funds.transfer', async () => {
          ran = true
          return 'done'
        })
        .guard('jwt')
      const ctx = makeCtx(JSON.stringify({ jsonrpc: '2.0', method: 'funds.transfer', id: 1 }))
      ctx.auth = authFor(scenario)
      await rpc.handle(ctx)
      const body: unknown = JSON.parse(String(ctx.response.getBody()))
      expect(ran).toBe(allowed)
      if (allowed) expect(body).toMatchObject({ result: 'done' })
      else expect(body).toMatchObject({ error: { code: -32003, message: 'Unauthorized' } })
    })
  }

  it('does not turn a crash behind the guard into a denial', async () => {
    const rpc = new RpcRouter()
    rpc.method('funds.transfer', async () => 'done').guard('jwt')
    const ctx = makeCtx(JSON.stringify({ jsonrpc: '2.0', method: 'funds.transfer', id: 1 }))
    ctx.auth = authFor({ canAuthenticate: ['jwt'], crashes: true })
    await rpc.handle(ctx)
    const body: unknown = JSON.parse(String(ctx.response.getBody()))
    expect(body).toMatchObject({ error: { code: -32603 } })
  })
})

describe('GraphQL resolver guard gate', () => {
  let resolved = false
  class TransferResolver {
    transfer(): string {
      resolved = true
      return 'done'
    }
  }

  function makeEngine(): GraphQLEngine {
    const dir = mkdtempSync(join(tmpdir(), 'ream-gql-guard-'))
    const schemaPath = join(dir, 'schema.graphql')
    writeFileSync(schemaPath, 'type Query { ping: String }\ntype Mutation { transfer: String }')
    const engine = new GraphQLEngine({ schemaPath })
    engine.resolver('Mutation', 'transfer', TransferResolver, 'transfer', { guard: 'jwt' })
    return engine
  }

  for (const [label, scenario, allowed] of cases) {
    it(`${allowed ? 'resolves' : 'refuses'} the field for ${label}`, async () => {
      resolved = false
      const ctx = makeCtx(JSON.stringify({ query: 'mutation { transfer }' }))
      ctx.auth = authFor(scenario)
      await makeEngine().handle(ctx)
      const body: unknown = JSON.parse(String(ctx.response.getBody()))
      expect(resolved).toBe(allowed)
      if (allowed) expect(body).toMatchObject({ data: { transfer: 'done' } })
      else expect(body).toMatchObject({ errors: [{ message: 'Unauthorized' }] })
    })
  }
})

describe('authenticatedByGuards', () => {
  it('does not re-authenticate a request already vouched for by a named guard', async () => {
    attempts.length = 0
    expect(await authenticatedByGuards(authFor({ via: 'jwt', canAuthenticate: [] }), ['jwt'])).toBe(
      true,
    )
    expect(attempts).toEqual([])
  })
})

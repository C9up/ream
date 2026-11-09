/**
 * A request authenticated with a token is held to the INTERSECTION of the
 * user's permissions and the token's abilities on every `.permission()` gate:
 * the HTTP route guard, the RPC method gate and the GraphQL resolver gate.
 *
 * Token scopes used to be merged into `user.permissions`, so any user could
 * obtain a route permission they did not hold by getting a token whose scope
 * carried the same name, and a token limited to `profile` still carried every
 * permission of its user.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GraphQLEngine } from '../../src/graphql/GraphQLEngine.js'
import { E_FORBIDDEN } from '../../src/http/Exception.js'
import { type AuthState, HttpContext } from '../../src/http/HttpContext.js'
import { holdsPermissions } from '../../src/http/permissions.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'

/** A token in the shape warden and visa hand over: abilities, and `allows`. */
function token(...abilities: string[]) {
  return { abilities, allows: (ability: string) => abilities.includes(ability) }
}

type Identity = { permissions: string[]; token?: ReturnType<typeof token> }

function authFor({ permissions, token: currentAccessToken }: Identity): AuthState {
  return {
    isAuthenticated: true,
    user: { id: 'u1', permissions, ...(currentAccessToken ? { currentAccessToken } : {}) },
  }
}

function makeCtx(body = '', method = 'POST'): HttpContext {
  return new HttpContext(
    'req-1',
    { method, path: '/', query: '', headers: { 'content-type': 'application/json' }, body },
    {},
    { pattern: '/', middleware: [] },
  )
}

const cases: Array<[label: string, identity: Identity, allowed: boolean]> = [
  [
    'a user without the permission, with a token whose scope has the same name',
    { permissions: [], token: token('orders:write') },
    false,
  ],
  [
    'a user with the permission, with a token that does not allow it',
    { permissions: ['orders:write'], token: token('profile') },
    false,
  ],
  [
    'a user with the permission, with a token that allows it',
    { permissions: ['orders:write'], token: token('orders:write') },
    true,
  ],
  ['a session user with the permission (no token)', { permissions: ['orders:write'] }, true],
  ['a session user without the permission (no token)', { permissions: [] }, false],
]

describe('HTTP route .permission() gate', () => {
  async function run(identity: Identity): Promise<{ ran: boolean; status?: number }> {
    let ran = false
    const chain = new MiddlewareRegistry().buildChain(
      [],
      [],
      async () => {
        ran = true
      },
      { permissions: ['orders:write'] },
    )
    const ctx = makeCtx('', 'GET')
    ctx.auth = authFor(identity)
    try {
      await chain(ctx, async () => {})
      return { ran }
    } catch (error) {
      if (!(error instanceof E_FORBIDDEN)) throw error
      return { ran, status: error.status }
    }
  }

  for (const [label, identity, allowed] of cases) {
    it(`${allowed ? 'admits' : 'refuses (403)'} ${label}`, async () => {
      const outcome = await run(identity)
      expect(outcome.ran).toBe(allowed)
      expect(outcome.status).toBe(allowed ? undefined : 403)
    })
  }
})

describe('RPC method .permission() gate', () => {
  async function run(identity: Identity): Promise<{ ran: boolean; body: unknown }> {
    let ran = false
    const rpc = new RpcRouter()
    rpc
      .method('orders.place', async () => {
        ran = true
        return 'placed'
      })
      .permission('orders:write')
    const ctx = makeCtx(JSON.stringify({ jsonrpc: '2.0', method: 'orders.place', id: 1 }))
    ctx.auth = authFor(identity)
    await rpc.handle(ctx)
    return { ran, body: JSON.parse(String(ctx.response.getBody())) }
  }

  for (const [label, identity, allowed] of cases) {
    it(`${allowed ? 'runs' : 'refuses'} the call for ${label}`, async () => {
      const outcome = await run(identity)
      expect(outcome.ran).toBe(allowed)
      if (allowed) {
        expect(outcome.body).toMatchObject({ result: 'placed' })
      } else {
        expect(outcome.body).toMatchObject({
          error: { code: -32003, message: 'Insufficient permissions' },
        })
      }
    })
  }
})

describe('GraphQL resolver permissions gate', () => {
  let resolved = false
  class OrderResolver {
    placeOrder(): string {
      resolved = true
      return 'placed'
    }
  }

  function makeEngine(): GraphQLEngine {
    const dir = mkdtempSync(join(tmpdir(), 'ream-gql-perm-'))
    const schemaPath = join(dir, 'schema.graphql')
    writeFileSync(schemaPath, 'type Query { ping: String }\ntype Mutation { placeOrder: String }')
    const engine = new GraphQLEngine({ schemaPath })
    engine.resolver('Mutation', 'placeOrder', OrderResolver, 'placeOrder', {
      permissions: ['orders:write'],
    })
    return engine
  }

  async function run(identity: Identity): Promise<{ ran: boolean; body: unknown }> {
    resolved = false
    const ctx = makeCtx(JSON.stringify({ query: 'mutation { placeOrder }' }))
    ctx.auth = authFor(identity)
    await makeEngine().handle(ctx)
    return { ran: resolved, body: JSON.parse(String(ctx.response.getBody())) }
  }

  for (const [label, identity, allowed] of cases) {
    it(`${allowed ? 'resolves' : 'refuses'} the field for ${label}`, async () => {
      const outcome = await run(identity)
      expect(outcome.ran).toBe(allowed)
      if (allowed) {
        expect(outcome.body).toMatchObject({ data: { placeOrder: 'placed' } })
      } else {
        expect(JSON.stringify(outcome.body)).toContain('Insufficient permissions')
      }
    })
  }
})

describe('holdsPermissions', () => {
  it('requires every permission, each allowed by the token', () => {
    const auth = authFor({ permissions: ['a', 'b'], token: token('a') })
    expect(holdsPermissions(auth, ['a'])).toBe(true)
    expect(holdsPermissions(auth, ['a', 'b'])).toBe(false)
  })

  it('reads top-level permissions too, still narrowed by the token', () => {
    const auth: AuthState = {
      isAuthenticated: true,
      permissions: ['a'],
      user: { id: 'u1', currentAccessToken: token() },
    }
    expect(holdsPermissions(auth, ['a'])).toBe(false)
  })

  it('denies when the token has no callable allows', () => {
    const auth: AuthState = {
      isAuthenticated: true,
      user: { id: 'u1', permissions: ['a'] },
    }
    // A provider outside TypeScript handing a token-shaped value without `allows`.
    Reflect.set(auth.user ?? {}, 'currentAccessToken', { abilities: ['a'] })
    expect(holdsPermissions(auth, ['a'])).toBe(false)
  })

  it('denies an unauthenticated state with no permissions', () => {
    expect(holdsPermissions(undefined, ['a'])).toBe(false)
    expect(holdsPermissions({ isAuthenticated: false }, ['a'])).toBe(false)
  })
})

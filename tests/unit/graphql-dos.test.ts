import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine } from '../../src/index.js'

/** Engine with deliberately tight limits so the guards are easy to trip. */
function makeEngine(): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-dos-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, 'type Query { ping: String }')
  return new GraphQLEngine({ schemaPath, maxDepth: 3, maxComplexity: 5, maxQueryBytes: 200 })
}

async function post(engine: GraphQLEngine, query: string): Promise<string> {
  const raw: RawRequest = {
    method: 'POST',
    path: '/graphql',
    query: '',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  }
  const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
  await engine.handle(ctx)
  return ctx.response.getBody()
}

describe('GraphQLEngine > DoS guards', () => {
  it('rejects a query nested deeper than maxDepth', async () => {
    const body = await post(makeEngine(), 'query { a { b { c { d { e } } } } }')
    expect(body).toContain('too deep')
  })

  it('rejects a query selecting more fields than maxComplexity', async () => {
    const body = await post(makeEngine(), 'query { a b c d e f g }')
    expect(body).toContain('too complex')
  })

  it('rejects a query string larger than maxQueryBytes before parsing', async () => {
    const body = await post(makeEngine(), `query { ${'a'.repeat(300)} }`)
    expect(body).toContain('maximum size')
  })

  it('lets a query within all limits through to resolution', async () => {
    // No resolver registered → "No resolver" error proves the DoS guards passed
    // (it reached resolution) rather than being rejected as too deep/complex/large.
    const body = await post(makeEngine(), 'query { ping }')
    expect(body).toContain('No resolver')
    expect(body).not.toContain('too deep')
    expect(body).not.toContain('too complex')
    expect(body).not.toContain('maximum size')
  })
})

describe('GraphQLEngine > CORS simple requests', () => {
  class Mutations {
    static runs = 0
    promote(): boolean {
      Mutations.runs += 1
      return true
    }
  }

  function mutationEngine(): GraphQLEngine {
    const dir = mkdtempSync(join(tmpdir(), 'ream-gql-csrf-'))
    const schemaPath = join(dir, 'schema.graphql')
    writeFileSync(schemaPath, 'type Query { ping: String } type Mutation { promote: Boolean }')
    const engine = new GraphQLEngine({ schemaPath })
    engine.resolver('Mutation', 'promote', Mutations, 'promote')
    return engine
  }

  async function send(headers: Record<string, string>): Promise<HttpContext> {
    const raw: RawRequest = {
      method: 'POST',
      path: '/graphql',
      query: '',
      headers,
      body: JSON.stringify({ query: 'mutation { promote }' }),
    }
    const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
    await mutationEngine().handle(ctx)
    return ctx
  }

  it('refuses a body that is not labelled JSON with 415, before any resolver runs', async () => {
    // A foreign page sends these cross-site with the user's cookies and no
    // preflight; a Blob with an empty type carries no Content-Type at all.
    Mutations.runs = 0
    const simple: Record<string, string>[] = [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'application/octet-stream' },
    ]
    for (const headers of simple) {
      const ctx = await send(headers)
      expect(ctx.response.getStatus()).toBe(415)
    }
    expect(Mutations.runs).toBe(0)
  })

  it('runs the same mutation sent as application/json', async () => {
    Mutations.runs = 0
    const ctx = await send({ 'content-type': 'application/json; charset=utf-8' })
    expect(ctx.response.getStatus()).toBe(200)
    expect(JSON.parse(ctx.response.getBody())).toEqual({ data: { promote: true } })
    expect(Mutations.runs).toBe(1)
  })
})

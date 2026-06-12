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

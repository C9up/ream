import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine } from '../../src/index.js'

class TaskResolver {
  task(): { id: number; title: string; secret: string } {
    return { id: 1, title: 'Ship the demo', secret: 'leak-me-not' }
  }
}

function makeEngine(): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-frag-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, 'type Query { task: Task } type Task { id: Int title: String }')
  const engine = new GraphQLEngine({ schemaPath })
  engine.resolver('Query', 'task', TaskResolver, 'task')
  return engine
}

async function exec(engine: GraphQLEngine, query: string): Promise<Record<string, unknown>> {
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

describe('GraphQLEngine > fragments (end-to-end via the Rust parser)', () => {
  it('expands a named fragment spread and prunes to its fields', async () => {
    const res = await exec(
      makeEngine(),
      'query { task { ...TaskFields } } fragment TaskFields on Task { id title }',
    )
    expect(res.data).toEqual({ task: { id: 1, title: 'Ship the demo' } })
    // The fragment selected only id+title — `secret` must not leak.
    expect(JSON.stringify(res)).not.toContain('leak-me-not')
  })

  it('merges fragment fields with explicit fields', async () => {
    const res = await exec(
      makeEngine(),
      'query { task { id ...Rest } } fragment Rest on Task { title }',
    )
    expect(res.data).toEqual({ task: { id: 1, title: 'Ship the demo' } })
  })

  it('expands an inline fragment', async () => {
    const res = await exec(makeEngine(), 'query { task { ... on Task { id title } } }')
    expect(res.data).toEqual({ task: { id: 1, title: 'Ship the demo' } })
  })

  it('refuses a cyclic fragment (NoFragmentCycles) instead of running the query', async () => {
    const res = await exec(makeEngine(), 'query { task { ...A } } fragment A on Task { id ...A }')
    expect(res.data).toBeUndefined()
    expect(res.errors).toEqual([{ message: 'Cannot spread fragment "A" within itself.' }])
  })

  it('stops a doubling chain of fragment spreads at the limit, fast', async () => {
    // `fragment F0 { ...F1 ...F1 } … fragment F40 { id }`: 2^40 fields if
    // expanded, ~1.7 KB of query. The native parser used to build the whole
    // tree on the event loop before any limit looked at it.
    let query = 'query { task { ...F0 } }\n'
    for (let i = 0; i < 40; i += 1) {
      query += `fragment F${i} on Task { ...F${i + 1} ...F${i + 1} }\n`
    }
    query += 'fragment F40 on Task { id }\n'
    const started = performance.now()
    const res = await exec(makeEngine(), query)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(res.errors).toEqual([{ message: 'Query is too complex (max 1000 fields)' }])
  })
})

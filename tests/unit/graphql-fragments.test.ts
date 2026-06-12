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

  it('does not hang on a cyclic fragment', async () => {
    const res = await exec(makeEngine(), 'query { task { ...A } } fragment A on Task { id ...A }')
    expect(res.data).toEqual({ task: { id: 1 } })
  })
})

import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine } from '../../src/index.js'

let captured: Record<string, unknown> = {}

class Resolver {
  task(_parent: unknown, args: Record<string, unknown>): { id: number } {
    captured = args
    return { id: 1 }
  }
}

function makeEngine(): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-coerce-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(
    schemaPath,
    'type Query { task(id: Int, ratio: Float, active: Boolean, ref: ID): Task } type Task { id: Int }',
  )
  const engine = new GraphQLEngine({ schemaPath })
  engine.resolver('Query', 'task', Resolver, 'task')
  return engine
}

async function exec(query: string, variables?: Record<string, unknown>): Promise<void> {
  captured = {}
  const raw: RawRequest = {
    method: 'POST',
    path: '/graphql',
    query: '',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }
  const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
  await makeEngine().handle(ctx)
}

describe('GraphQLEngine > argument coercion (schema-driven)', () => {
  it('coerces string literals to their declared scalar types', async () => {
    await exec('query { task(id: "5", ratio: "1.5", active: "true", ref: 42) { id } }')
    expect(captured.id).toBe(5)
    expect(captured.ratio).toBe(1.5)
    expect(captured.active).toBe(true)
    // ID is serialized as a string — a numeric literal becomes "42".
    expect(captured.ref).toBe('42')
  })

  it('coerces a string variable to the declared Int type', async () => {
    await exec('query Q($id: Int) { task(id: $id) { id } }', { id: '7' })
    expect(captured.id).toBe(7)
  })

  it('leaves an already-correct value untouched', async () => {
    await exec('query { task(id: 9, active: false) { id } }')
    expect(captured.id).toBe(9)
    expect(captured.active).toBe(false)
  })

  it('does not coerce a non-numeric string for an Int arg (leaves it as-is)', async () => {
    await exec('query { task(id: "abc") { id } }')
    expect(captured.id).toBe('abc')
  })
})

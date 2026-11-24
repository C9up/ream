/**
 * Validation errors are capped (graphql-js `maxErrors`, 100 by default) and
 * each message is reported once: a small query cannot be answered with one
 * message per undeclared variable, argument or field it names.
 *
 * The bound is proved on small inputs; the full-size request is never built.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { GraphQLEngine } from '../../src/index.js'

const ABORTED = 'Too many validation errors, error limit reached. Validation aborted.'

let runs = 0
class Resolvers {
  f(): boolean {
    runs += 1
    return true
  }
}

function makeEngine(config: { maxErrors?: number } = {}): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-errors-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, 'type Query { f(a: [Int]): Boolean }')
  const engine = new GraphQLEngine({ schemaPath, ...config })
  engine.resolver('Query', 'f', Resolvers, 'f')
  return engine
}

async function exec(
  engine: GraphQLEngine,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ messages: string[]; bytes: number }> {
  const raw: RawRequest = {
    method: 'POST',
    path: '/graphql',
    query: '',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }
  const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
  await engine.handle(ctx)
  const text = ctx.response.getBody()
  const body: { errors?: Array<{ message: string }> } = JSON.parse(text)
  return { messages: (body.errors ?? []).map((error) => error.message), bytes: text.length }
}

const variables = (n: number): string => Array.from({ length: n }, (_, i) => `$v${i}`).join(' ')

describe('graphql > the number of validation errors is bounded', () => {
  it('stops at 100 undeclared variables and says so', async () => {
    runs = 0
    const { messages } = await exec(makeEngine(), `{ f(a: [${variables(300)}]) }`)
    expect(messages).toHaveLength(101)
    expect(messages[0]).toBe('Variable "$v0" is not defined.')
    expect(messages[99]).toBe('Variable "$v99" is not defined.')
    expect(messages[100]).toBe(ABORTED)
    expect(runs).toBe(0)
  })

  it('answers the same size whatever the number of errors past the limit', async () => {
    const engine = makeEngine()
    const small = await exec(engine, `{ f(a: [${variables(200)}]) }`)
    const large = await exec(engine, `{ f(a: [${variables(800)}]) }`)
    expect(large.messages).toHaveLength(101)
    // Four times the input, the same reply: `$v0`…`$v99`, then the notice.
    expect(large.bytes).toBe(small.bytes)
  })

  it('reports every error when there are fewer than the limit', async () => {
    const { messages } = await exec(makeEngine(), `{ f(a: [${variables(100)}]) }`)
    expect(messages).toHaveLength(100)
    expect(messages).not.toContain(ABORTED)
  })

  it('reports a repeated error once', async () => {
    const { messages } = await exec(makeEngine(), '{ f(a: [$v $v $v]) g: f(a: [$v]) }')
    expect(messages).toEqual(['Variable "$v" is not defined.'])
  })

  it('takes the limit from maxErrors', async () => {
    const { messages } = await exec(makeEngine({ maxErrors: 3 }), `{ f(a: [${variables(10)}]) }`)
    expect(messages).toEqual([
      'Variable "$v0" is not defined.',
      'Variable "$v1" is not defined.',
      'Variable "$v2" is not defined.',
      ABORTED,
    ])
  })

  it('bounds the errors the engine finds against the schema too', async () => {
    const engine = makeEngine({ maxErrors: 5 })
    // One field, many arguments it does not declare.
    const args = Array.from({ length: 40 }, (_, i) => `x${i}: 1`).join(' ')
    const unknownArguments = await exec(engine, `{ f(${args}) }`)
    expect(unknownArguments.messages).toHaveLength(6)
    expect(unknownArguments.messages[0]).toBe('Unknown argument "x0" on field "Query.f".')
    expect(unknownArguments.messages[5]).toBe(ABORTED)
    // Many fields the type does not declare.
    const fields = Array.from({ length: 40 }, (_, i) => `u${i}`).join(' ')
    const unknownFields = await exec(engine, `{ ${fields} }`)
    expect(unknownFields.messages).toHaveLength(6)
    expect(unknownFields.messages[5]).toBe(ABORTED)
    // Many required variables left out of the request.
    const declared = Array.from({ length: 40 }, (_, i) => `$r${i}: Int!`).join(' ')
    const missingVariables = await exec(engine, `query Q(${declared}) { f }`)
    expect(missingVariables.messages).toHaveLength(6)
    expect(missingVariables.messages[5]).toBe(ABORTED)
  })

  it('still runs a valid query', async () => {
    runs = 0
    const engine = makeEngine()
    const raw: RawRequest = {
      method: 'POST',
      path: '/graphql',
      query: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query Q($a: [Int]) { f(a: $a) }', variables: { a: [1] } }),
    }
    const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
    await engine.handle(ctx)
    expect(JSON.parse(ctx.response.getBody())).toEqual({ data: { f: true } })
    expect(runs).toBe(1)
  })
})

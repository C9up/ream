import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { Exception, GraphQLEngine } from '../../src/index.js'

class Resolvers {
  secret(): never {
    throw new Error('ECONNREFUSED db-internal.local:5432 user=admin')
  }
  forbidden(): never {
    throw new Exception('You may not read this', { status: 403, code: 'E_FORBIDDEN' })
  }
  exposed(): never {
    throw Object.assign(new Error('Quota reached'), { expose: true })
  }
}

function makeEngine(debug?: boolean): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-errors-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, 'type Query { secret: String forbidden: String exposed: String }')
  const engine = new GraphQLEngine({ schemaPath, debug })
  engine.resolver('Query', 'secret', Resolvers, 'secret')
  engine.resolver('Query', 'forbidden', Resolvers, 'forbidden')
  engine.resolver('Query', 'exposed', Resolvers, 'exposed')
  return engine
}

async function query(
  engine: GraphQLEngine,
  source: string,
): Promise<{ body: { errors?: Array<{ message: string }> }; logged: string[] }> {
  const raw: RawRequest = {
    method: 'POST',
    path: '/graphql',
    query: '',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: source }),
  }
  const ctx = new HttpContext('t', raw, {}, { pattern: '/graphql', middleware: [] })
  const logged: string[] = []
  const record = (_message: string, data?: Record<string, unknown>): void => {
    logged.push(String(data?.message))
  }
  ctx.setBaseLogger({
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
    fatal: record,
  })
  await engine.handle(ctx)
  return { body: JSON.parse(ctx.response.getBody()), logged }
}

const savedEnv = process.env.NODE_ENV
afterEach(() => {
  if (savedEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
  else process.env.NODE_ENV = savedEnv
})

describe('GraphQLEngine > resolver error messages', () => {
  it('never echoes a library error to the client in production, and logs it instead', async () => {
    process.env.NODE_ENV = 'production'
    const { body, logged } = await query(makeEngine(), '{ secret }')
    expect(body.errors?.[0]?.message).toBe('Internal server error')
    expect(JSON.stringify(body)).not.toContain('db-internal')
    expect(logged).toEqual(['ECONNREFUSED db-internal.local:5432 user=admin'])
  })

  it('collapses it too when NODE_ENV is unset or unrecognised', async () => {
    for (const env of ['', 'staging']) {
      process.env.NODE_ENV = env
      const { body } = await query(makeEngine(), '{ secret }')
      expect(body.errors?.[0]?.message).toBe('Internal server error')
    }
  })

  it('keeps the message of a deliberate Exception and of an exposed error', async () => {
    process.env.NODE_ENV = 'production'
    const { body } = await query(makeEngine(), '{ forbidden exposed }')
    expect(body.errors?.map((error) => error.message)).toEqual([
      'You may not read this',
      'Quota reached',
    ])
  })

  it('echoes every message in debug mode', async () => {
    process.env.NODE_ENV = 'production'
    const { body } = await query(makeEngine(true), '{ secret }')
    expect(body.errors?.[0]?.message).toBe('ECONNREFUSED db-internal.local:5432 user=admin')
  })
})

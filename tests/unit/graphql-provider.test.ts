import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppContext } from '../../src/index.js'
import { Container, GraphQLEngine, GraphQLProvider, ReamError } from '../../src/index.js'

function buildApp(container: Container): AppContext {
  const config = { get: () => undefined, set: () => {} }
  return { container, config }
}

/** Construct a real GraphQLEngine backed by a throwaway schema file. */
function makeEngine(): GraphQLEngine {
  const dir = mkdtempSync(join(tmpdir(), 'ream-gql-'))
  const schemaPath = join(dir, 'schema.graphql')
  writeFileSync(schemaPath, 'type Query { ping: String }')
  return new GraphQLEngine({ schemaPath })
}

describe('GraphQLProvider > opt-in', () => {
  it('is a no-op when graphql is not configured', async () => {
    const container = new Container()
    const provider = new GraphQLProvider(buildApp(container))
    provider.register()
    expect(provider.engine).toBeUndefined()
    expect(() => container.resolve('graphql')).toThrow()
    await provider.boot() // no router needed — returns early
  })
})

describe('GraphQLProvider > wired', () => {
  it('binds the engine under the `graphql` token', () => {
    const container = new Container()
    const engine = makeEngine()
    const provider = new GraphQLProvider(buildApp(container), { engine })
    provider.register()
    expect(provider.engine).toBe(engine)
    expect(container.resolve('graphql')).toBe(engine)
  })

  it('mounts GET + POST at engine.path on boot', async () => {
    const container = new Container()
    const verbs: Array<[string, string]> = []
    container.singleton('router', () => ({
      get(path: string): void {
        verbs.push(['GET', path])
      },
      post(path: string): void {
        verbs.push(['POST', path])
      },
    }))
    const provider = new GraphQLProvider(buildApp(container), { engine: makeEngine() })
    provider.register()
    await provider.boot()
    expect(verbs).toEqual([
      ['GET', '/graphql'],
      ['POST', '/graphql'],
    ])
  })

  // Pinning test (epic-24 retro A1): lock the collision guard the 56.6 refactor
  // dropped, so a future refactor cannot erase it unnoticed.
  it('re-registering the same provider instance is idempotent (no throw)', () => {
    const container = new Container()
    const provider = new GraphQLProvider(buildApp(container), { engine: makeEngine() })
    provider.register()
    const engine = provider.engine
    expect(() => provider.register()).not.toThrow()
    expect(provider.engine).toBe(engine)
  })

  it('throws GRAPHQL_PROVIDER_ALREADY_REGISTERED when a different engine claims the `graphql` token', () => {
    const container = new Container()
    new GraphQLProvider(buildApp(container), { engine: makeEngine() }).register()
    const other = new GraphQLProvider(buildApp(container), { engine: makeEngine() })
    try {
      other.register()
      expect.fail('expected register() to throw on a duplicate graphql binding')
    } catch (error) {
      expect(error).toBeInstanceOf(ReamError)
      if (error instanceof ReamError) {
        expect(error.code).toBe('GRAPHQL_PROVIDER_ALREADY_REGISTERED')
      }
    }
  })
})

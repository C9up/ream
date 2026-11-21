/**
 * The two pages ream serves from a CDN — GraphiQL and Swagger UI — load
 * third-party code. Each file is pinned to an exact version and carries its
 * Subresource Integrity hash, so the browser refuses one the CDN serves
 * different from the file that was hashed: a floating `@5` handed every
 * future release of the package, or a compromised CDN, the run of the page.
 */
import 'reflect-metadata'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GraphQLEngine } from '../../src/graphql/GraphQLEngine.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { OpenApiMiddleware } from '../../src/openapi/OpenApiMiddleware.js'

function get(path: string): HttpContext {
  const raw: RawRequest = { method: 'GET', path, query: '', headers: {}, body: '' }
  return new HttpContext('t', raw, {}, { pattern: path, middleware: [] })
}

/** Every external `<script src>` and stylesheet `<link href>` of a page. */
function externalTags(html: string): string[] {
  return [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="https:\/\/[^"]+"[^>]*>/g)].map(
    (match) => match[0],
  )
}

function expectPinnedWithIntegrity(html: string, count: number): void {
  const tags = externalTags(html)
  expect(tags).toHaveLength(count)
  for (const tag of tags) {
    // An exact version: `name@1.2.3/`, never `name@5/`.
    expect(tag).toMatch(/@\d+\.\d+\.\d+\//)
    expect(tag).toMatch(/integrity="sha384-[A-Za-z0-9+/]{64}"/)
    // Without CORS mode the browser cannot check a cross-origin hash.
    expect(tag).toContain('crossorigin="anonymous"')
  }
}

describe('CDN pages > pinned and integrity-checked', () => {
  it('GraphiQL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-gql-sri-'))
    const schemaPath = join(dir, 'schema.graphql')
    writeFileSync(schemaPath, 'type Query { ping: String }')
    const ctx = get('/graphql')
    await new GraphQLEngine({ schemaPath, playground: true }).handle(ctx)
    expectPinnedWithIntegrity(ctx.response.getBody(), 4)
  })

  it('Swagger UI', async () => {
    const ctx = get('/docs')
    await new OpenApiMiddleware({ spec: { openapi: '3.1.0', info: { title: 'T' } } }).handle(
      ctx,
      async () => {},
    )
    expectPinnedWithIntegrity(ctx.response.getBody(), 2)
  })
})

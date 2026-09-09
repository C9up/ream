import { describe, expect, it } from 'vitest'
import { OpenApiGenerator, Router } from '../../src/index.js'

const noop = () => {}

function gen(build: (r: Router) => void, runeSchemas?: Map<string, Record<string, unknown>>) {
  const router = new Router()
  build(router)
  return new OpenApiGenerator(
    router,
    {
      title: 'My API',
      version: '2.0.0',
      description: 'Docs',
      contact: { name: 'Support', email: 's@x.io' },
      license: { name: 'MIT' },
      servers: [{ url: 'https://api.x.io' }],
    },
    runeSchemas,
  ).generate()
}

describe('OpenApiGenerator', () => {
  it('emits info + servers from config', () => {
    const spec = gen((r) => r.get('/ping', noop))
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info).toMatchObject({
      title: 'My API',
      version: '2.0.0',
      description: 'Docs',
      contact: { name: 'Support', email: 's@x.io' },
      license: { name: 'MIT' },
    })
    expect(spec.servers).toEqual([{ url: 'https://api.x.io' }])
  })

  it('builds a path + operation per route method', () => {
    const spec = gen((r) => {
      r.get('/tasks', noop)
      r.post('/tasks', noop)
    })
    expect(spec.paths['/tasks']?.get).toBeDefined()
    expect(spec.paths['/tasks']?.post).toBeDefined()
  })

  it('converts :param to {param} and emits a path parameter', () => {
    const spec = gen((r) => r.get('/users/:id', noop))
    expect(spec.paths['/users/{id}']?.get).toMatchObject({
      parameters: [{ name: 'id', in: 'path', required: true }],
    })
  })

  it('adds security + 401 for a guarded route and 403 for roles', () => {
    const spec = gen((r) => r.get('/admin', noop).guard('jwt').role('admin'))
    expect(spec.paths['/admin']?.get).toMatchObject({
      security: [{ jwt: [] }],
      responses: { '401': {}, '403': {} },
    })
    // The guard is registered as a security scheme.
    expect(spec.components.securitySchemes.jwt).toBeDefined()
  })

  it('marks deprecated routes and stamps the version', () => {
    const spec = gen((r) =>
      r.get('/old', noop).version('1.0').deprecates('2.0', { sunset: '2027-01-01' }),
    )
    expect(spec.paths['/old']?.get).toMatchObject({
      deprecated: true,
      'x-sunset': '2027-01-01',
      'x-api-version': '1.0',
    })
  })

  it('attaches a requestBody from a registered validator schema on POST', () => {
    const schemas = new Map<string, Record<string, unknown>>([
      ['createUser', { name: { type: 'string' } }],
    ])
    const spec = gen((r) => r.post('/users', noop).validate('createUser'), schemas)
    expect(spec.paths['/users']?.post).toMatchObject({ requestBody: { required: true } })
    expect(spec.components.schemas.createUser).toBeDefined()
  })

  it('falls back to a generic object body when the validator is unregistered', () => {
    const spec = gen((r) => r.post('/x', noop).validate('unknownValidator'))
    expect(spec.paths['/x']?.post).toMatchObject({ requestBody: { required: true } })
  })
})

describe('OpenApiGenerator > schemas from the routes themselves', () => {
  /** A validator that can describe its own shape, as a rune schema does. */
  function selfDescribing(properties: Record<string, unknown>) {
    return {
      toJSONSchema: () => ({
        type: 'object',
        properties,
        required: Object.keys(properties),
      }),
    }
  }

  function generatorFor(build: (r: Router) => void) {
    const router = new Router()
    build(router)
    return new OpenApiGenerator(router, { title: 'API', version: '1.0.0' })
  }

  it('asks a route validator to describe itself', async () => {
    const generator = generatorFor((r) => {
      r.post('/users', noop).validate('createUser')
    })
    const registry = new Map<string, unknown>([
      ['validator:createUser', selfDescribing({ email: { type: 'string' } })],
    ])
    await generator.hydrateSchemas((token) => Promise.resolve(registry.get(token)))

    const spec = generator.generate()
    // Before this, a validated route documented its body as a bare object —
    // an API client generated from the spec knew none of the fields.
    expect(spec.paths['/users']?.post).toMatchObject({
      requestBody: {
        content: {
          'application/json': {
            schema: { properties: { email: { type: 'string' } } },
          },
        },
      },
    })
    expect(spec.components.schemas.createUser).toBeDefined()
  })

  it('leaves a hand-registered schema alone', async () => {
    const generator = generatorFor((r) => {
      r.post('/users', noop).validate('createUser')
    })
    // `registerSchema` takes a rune FIELD MAP, which the generator converts.
    generator.registerSchema('createUser', {
      handRegistered: { rules: [{ name: 'number' }] },
    })
    await generator.hydrateSchemas(() =>
      Promise.resolve(selfDescribing({ described: { type: 'string' } })),
    )
    const schema = generator.generate().components.schemas.createUser
    expect(schema).toMatchObject({
      properties: { handRegistered: { type: 'number' } },
    })
    expect(schema).not.toHaveProperty('properties.described')
  })

  it('still produces a spec when a validator cannot be resolved', async () => {
    const generator = generatorFor((r) => {
      r.post('/users', noop).validate('missing')
    })
    // An unregistered validator is already a hard error at request time.
    // Failing the documentation over it too would take the whole spec down.
    await generator.hydrateSchemas(() => Promise.reject(new Error('nope')))
    expect(generator.generate().paths['/users']?.post).toMatchObject({
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    })
  })

  it('skips a validator that cannot describe itself', async () => {
    const generator = generatorFor((r) => {
      r.post('/users', noop).validate('opaque')
    })
    await generator.hydrateSchemas(() => Promise.resolve({ validate: () => ({ valid: true }) }))
    expect(generator.generate().components.schemas.opaque).toBeUndefined()
  })
})

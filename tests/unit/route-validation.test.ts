import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container, createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'

function hasStringName(data: unknown): data is { name: string } {
  return (
    data !== null &&
    typeof data === 'object' &&
    'name' in data &&
    typeof (data as { name: unknown }).name === 'string'
  )
}

/** Minimal rune-shaped validator: requires a non-empty string `name`, trims it. */
const nameValidator = {
  validate(data: unknown) {
    if (hasStringName(data) && data.name.length > 0) {
      return { valid: true, errors: [], data: { name: data.name.trim() } }
    }
    return { valid: false, errors: [{ field: 'name', message: 'name is required' }] }
  },
}

function postJson(kernel: ReturnType<typeof createHttpKernel>, path: string, body: unknown) {
  return kernel({
    method: 'POST',
    path,
    query: '',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('route .validate() — runtime validation', () => {
  it('passes a valid body and exposes the coerced payload on request.validated()', async () => {
    const container = new Container()
    container.singleton('validator:createUser', () => nameValidator)
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let seen: unknown

    router
      .post('/users', async (ctx) => {
        seen = ctx.request.validated()
        ctx.response.json({ ok: true })
      })
      .validate('createUser')

    const kernel = createHttpKernel({ router, middleware, container })
    const res = await postJson(kernel, '/users', { name: '  Ada  ' })

    expect(res.status).toBe(200)
    // The validator trimmed the value — handler sees the coerced data, not raw input.
    expect(seen).toEqual({ name: 'Ada' })
  })

  it('rejects an invalid body with 422 E_VALIDATION_ERROR and never runs the handler', async () => {
    const container = new Container()
    container.singleton('validator:createUser', () => nameValidator)
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let handlerRan = false

    router
      .post('/users', async () => {
        handlerRan = true
      })
      .validate('createUser')

    const kernel = createHttpKernel({ router, middleware, container })
    const res = await postJson(kernel, '/users', { name: '' })

    expect(res.status).toBe(422)
    expect(JSON.parse(res.body).errors[0].field).toBe('name')
    expect(handlerRan).toBe(false)
  })

  it('is a hard error (not a silent skip) when the validator name is unregistered', async () => {
    const container = new Container()
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    const errors: unknown[] = []

    router.post('/users', async () => {}).validate('createUser') // never registered

    const kernel = createHttpKernel({
      router,
      middleware,
      container,
      onError: (err) => errors.push(err),
    })
    const res = await postJson(kernel, '/users', { name: 'Ada' })

    expect(res.status).toBe(500)
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('E_VALIDATOR_NOT_FOUND')
  })
})

describe('route .validate() — async validator contracts', () => {
  /**
   * The contract rune actually exposes. `validateResult()` is synchronous and
   * THROWS when the schema carries async rules (unique/exists/useAsync), which
   * is how a 422 used to surface as a 500 — so it must not be the one picked
   * when the async form exists.
   */
  const asyncValidator = {
    validateResult() {
      throw new Error(
        'rune: this schema has async rules (unique/exists/useAsync) — call validateResultAsync() instead of validate().',
      )
    },
    async validateResultAsync(data: unknown) {
      if (hasStringName(data) && data.name !== 'taken') {
        return { valid: true, errors: [], data: { name: data.name.trim() } }
      }
      return {
        valid: false,
        errors: [{ field: 'name', rule: 'unique', message: 'name is already taken' }],
      }
    },
  }

  it('runs a schema carrying async rules instead of failing with a 500', async () => {
    const container = new Container()
    container.singleton('validator:createUser', () => asyncValidator)
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let seen: unknown

    router
      .post('/users', async (ctx) => {
        seen = ctx.request.validated()
        ctx.response.json({ ok: true })
      })
      .validate('createUser')

    const kernel = createHttpKernel({ router, middleware, container })
    const res = await postJson(kernel, '/users', { name: '  Ada  ' })

    expect(res.status).toBe(200)
    expect(seen).toEqual({ name: 'Ada' })
  })

  it('reports an async rule failure as 422, not 500', async () => {
    const container = new Container()
    container.singleton('validator:createUser', () => asyncValidator)
    const router = new Router()
    const middleware = new MiddlewareRegistry()

    router.post('/users', async () => {}).validate('createUser')

    const kernel = createHttpKernel({ router, middleware, container })
    const res = await postJson(kernel, '/users', { name: 'taken' })

    expect(res.status).toBe(422)
    expect(JSON.parse(res.body).errors[0].rule).toBe('unique')
  })

  it('translates a throwing VineJS-style validate() into a 422', async () => {
    // VineJS's `validate()` resolves to the validated payload and throws
    // E_VALIDATION_ERROR carrying `messages` — the only contract a plain
    // `@vinejs/vine` validator exposes.
    class ValidationFailure extends Error {
      readonly messages = [{ field: 'name', rule: 'required', message: 'name is required' }]
    }
    const vineStyle = {
      async validate(data: unknown) {
        if (!hasStringName(data) || data.name.length === 0) throw new ValidationFailure()
        return { name: data.name }
      },
    }

    const container = new Container()
    container.singleton('validator:createUser', () => vineStyle)
    const router = new Router()
    const middleware = new MiddlewareRegistry()
    let seen: unknown

    router
      .post('/users', async (ctx) => {
        seen = ctx.request.validated()
        ctx.response.json({ ok: true })
      })
      .validate('createUser')

    const kernel = createHttpKernel({ router, middleware, container })

    const ok = await postJson(kernel, '/users', { name: 'Ada' })
    expect(ok.status).toBe(200)
    expect(seen).toEqual({ name: 'Ada' })

    const ko = await postJson(kernel, '/users', { name: '' })
    expect(ko.status).toBe(422)
    expect(JSON.parse(ko.body).errors[0].field).toBe('name')
  })
})

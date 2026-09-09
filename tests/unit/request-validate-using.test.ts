/**
 * `request.validateUsing()` — the seam that lets a schema stay ignorant.
 *
 * A validator is compiled when its module loads. What language to answer in,
 * and where the errors go, are decided per request. Without this, the two
 * could only meet if every schema imported the i18n package, or if the app
 * passed a provider by hand at every call site. The static hooks are the
 * alternative: one assignment at boot, and every call picks it up.
 */
import { describe, expect, it } from 'vitest'
import type { RawRequest } from '../../src/http/Request.js'
import { Request } from '../../src/http/Request.js'
import { RequestValidator } from '../../src/http/RequestValidator.js'

function raw(over: Partial<RawRequest> = {}): RawRequest {
  return {
    method: 'POST',
    path: '/users',
    query: '',
    headers: { host: 'app.test', 'content-type': 'application/json' },
    body: '{"name":"ab"}',
    ...over,
  }
}

function request(
  over: Partial<RawRequest> = {},
  params: Record<string, string | string[]> = {},
): Request {
  return new Request(raw(over), params)
}

/** Records what it was handed instead of validating. */
function spyValidator() {
  const seen: { data?: Record<string, unknown>; options?: unknown } = {}
  return {
    seen,
    validate(data: Record<string, unknown>, options?: unknown) {
      seen.data = data
      seen.options = options
      return Promise.resolve(data)
    },
  }
}

describe('ream > request.validateUsing', () => {
  it('hands the validator the request, with params and headers kept apart', async () => {
    const r = request({ query: 'page=2' }, { id: '7' })
    const v = spyValidator()
    await r.validateUsing(v)

    expect(v.seen.data?.name).toBe('ab')
    expect(v.seen.data?.page).toBe('2')
    // Nested, not merged: a form field called `params` is ordinary, and
    // flattening would let a route parameter land as a top-level key, where it
    // would shadow — or be shadowed by — a body field of the same name.
    expect(v.seen.data?.params).toEqual({ id: '7' })
    expect(v.seen.data).not.toHaveProperty('id')
    expect(v.seen.data).toHaveProperty('headers')
    expect(v.seen.data).toHaveProperty('cookies')
  })

  it('validates the data it was given instead, when asked', async () => {
    const v = spyValidator()
    await request().validateUsing(v, { data: { only: 'this' } })
    expect(v.seen.data).toEqual({ only: 'this' })
  })

  it('applies the messages provider a package installed at boot', async () => {
    const provider = { getMessage: () => 'translated' }
    RequestValidator.messagesProvider = () => provider
    try {
      const v = spyValidator()
      await request().validateUsing(v)
      expect(v.seen.options).toMatchObject({ messagesProvider: provider })
    } finally {
      RequestValidator.messagesProvider = undefined
    }
  })

  it('hands the hook the whole context, not just the request', async () => {
    const r = request()
    const i18n = { tag: 'per-request' }
    // A hook reads `ctx.i18n` off what it is given; handing it a bare request
    // would make the one thing it exists for unreachable.
    r.ctx = { request: r, i18n }
    let seenI18n: unknown
    RequestValidator.messagesProvider = (ctx) => {
      seenI18n = 'i18n' in ctx ? ctx.i18n : undefined
      return { getMessage: () => '' }
    }
    try {
      await r.validateUsing(spyValidator())
      expect(seenI18n).toBe(i18n)
    } finally {
      RequestValidator.messagesProvider = undefined
    }
  })

  it('lets an explicit option outrank the boot-time hook', async () => {
    const mine = { getMessage: () => 'mine' }
    RequestValidator.messagesProvider = () => ({ getMessage: () => 'theirs' })
    try {
      const v = spyValidator()
      await request().validateUsing(v, { messagesProvider: mine })
      expect(v.seen.options).toMatchObject({ messagesProvider: mine })
    } finally {
      RequestValidator.messagesProvider = undefined
    }
  })

  it('wraps the error reporter in a factory, so each run gets a fresh one', async () => {
    const reporter = { report: () => undefined }
    RequestValidator.errorReporter = () => reporter
    try {
      const v = spyValidator()
      await request().validateUsing(v)
      const options = v.seen.options
      expect(options).toBeTypeOf('object')
      const factory =
        options !== null && typeof options === 'object' && 'errorReporter' in options
          ? options.errorReporter
          : undefined
      expect(factory).toBeTypeOf('function')
      expect(typeof factory === 'function' ? factory() : undefined).toBe(reporter)
    } finally {
      RequestValidator.errorReporter = undefined
    }
  })

  it('answers a tuple rather than throwing, on tryValidateUsing', async () => {
    const boom = new Error('nope')
    const failing = {
      validate: () => Promise.reject(boom),
    }
    expect(await request().tryValidateUsing(failing)).toEqual([boom, null])
    expect(await request().tryValidateUsing(spyValidator())).toEqual([
      null,
      expect.objectContaining({ name: 'ab' }),
    ])
  })
})

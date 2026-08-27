import { describe, expect, it } from 'vitest'
import type { HttpError } from '../../src/http/Exception.js'
 import { createError, E_VALIDATION_ERROR, Exception, ExceptionHandler } from '../../src/http/Exception.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function ctxWith(accept?: string): HttpContext {
  const headers: Record<string, string> = {}
  if (accept !== undefined) headers.accept = accept
  const raw: RawRequest = { method: 'GET', path: '/', query: '', headers, body: '' }
  return new HttpContext('req-1', raw, {}, { pattern: '/', middleware: [] })
}

describe('createError (AdonisJS parity)', () => {
  it('builds an Exception subclass with static status/code and formatted message', () => {
    const E_RESOURCE_MISSING = createError('Resource %s not found', 'E_RESOURCE_MISSING', 404)
    expect(E_RESOURCE_MISSING.status).toBe(404)
    expect(E_RESOURCE_MISSING.code).toBe('E_RESOURCE_MISSING')

    const err = new E_RESOURCE_MISSING('user-42')
    expect(err).toBeInstanceOf(Exception)
    expect(err.message).toBe('Resource user-42 not found')
    expect(err.status).toBe(404)
    expect(err.code).toBe('E_RESOURCE_MISSING')
  })
})

describe('Exception.help', () => {
  it('copies the static help onto instances and into debug JSON', async () => {
    class E_NEEDS_KEY extends Exception {
      static override code = 'E_NEEDS_KEY'
      static override status = 500
      static override help = 'Set APP_KEY in your environment.'
    }
    const err = new E_NEEDS_KEY('missing key')
    expect(err.help).toBe('Set APP_KEY in your environment.')

    const handler = new ExceptionHandler(true)
    const ctx = ctxWith('application/json')
    await handler.handle(err, ctx)
    expect(JSON.parse(ctx.response.getBody()).error.help).toBe('Set APP_KEY in your environment.')
  })
})

describe('ExceptionHandler > content negotiation', () => {
  it('defaults to JSON with no Accept header (ream API-first deviation)', async () => {
    const ctx = ctxWith()
    await new ExceptionHandler().handle(new Exception('boom', { status: 500 }), ctx)
    expect(ctx.response.getStatus()).toBe(500)
    expect(JSON.parse(ctx.response.getBody()).error.code).toBe('E_UNKNOWN')
  })

  it('renders HTML when the client prefers text/html', async () => {
    const ctx = ctxWith('text/html')
    await new ExceptionHandler().handle(new Exception('boom', { status: 404, code: 'E_X' }), ctx)
    expect(ctx.response.getBody()).toContain('<h1>404</h1>')
  })

  it('renders JSON:API for application/vnd.api+json', async () => {
    const ctx = ctxWith('application/vnd.api+json')
    await new ExceptionHandler().handle(new Exception('boom', { status: 422, code: 'E_V' }), ctx)
    const body = JSON.parse(ctx.response.getBody())
    expect(body.errors[0]).toMatchObject({ code: 'E_V', status: '422' })
  })
})

describe('ExceptionHandler > self-handling (duck-typed)', () => {
  it('delegates to a plain thrown object exposing handle()', async () => {
    const ctx = ctxWith('application/json')
    const custom = {
      handle(_error: unknown, c: HttpContext) {
        c.response.status(418).json({ tea: true })
      },
    }
    await new ExceptionHandler().handle(custom, ctx)
    expect(ctx.response.getStatus()).toBe(418)
    expect(JSON.parse(ctx.response.getBody()).tea).toBe(true)
  })
})

describe('ExceptionHandler > status pages', () => {
  it('renders a matching status page for a range key', async () => {
    class Handler extends ExceptionHandler {
      protected override renderStatusPages = true
      protected override statusPages = {
        '500..599': () => '<p>Server is on fire</p>',
      }
    }
    const ctx = ctxWith('text/html')
    await new Handler().handle(new Exception('boom', { status: 503 }), ctx)
    expect(ctx.response.getStatus()).toBe(503)
    expect(ctx.response.getBody()).toBe('<p>Server is on fire</p>')
  })
})

describe('ExceptionHandler > shouldReport + getErrorLogLevel', () => {
  // Both hooks take the normalised `HttpError`, as they do in AdonisJS — the
  // handler normalises once and every override downstream reads one shape.
  class Probe extends ExceptionHandler {
    reportable(error: unknown): boolean {
      return this.shouldReport(this.toHttpError(error))
    }
    level(status: number): string {
      return this.getErrorLogLevel(this.toHttpError(new Exception('probe', { status })))
    }
  }

  it('skips ignored statuses/codes and ignoreExceptions', () => {
    class Ignorable extends Exception {
      static override code = 'E_IGNORE_ME'
      static override status = 500
    }
    class Handler extends Probe {
      protected override ignoreExceptions = [Ignorable]
    }
    const probe = new Handler()
    expect(probe.reportable(new Exception('x', { status: 404 }))).toBe(false) // ignored status
    expect(probe.reportable(new Ignorable('x'))).toBe(false) // ignored class
    expect(probe.reportable(new Exception('x', { status: 500 }))).toBe(true)
  })

  it('honours the reportErrors master switch', () => {
    class Silent extends Probe {
      protected override reportErrors = false
    }
    expect(new Silent().reportable(new Exception('x', { status: 500 }))).toBe(false)
  })

  it('maps status to log level', () => {
    const probe = new Probe()
    expect(probe.level(503)).toBe('error')
    expect(probe.level(404)).toBe('warn')
    expect(probe.level(200)).toBe('info')
  })
})

describe('ExceptionHandler > render hooks (AdonisJS override points)', () => {
  /** Read what the handler wrote onto the response, JSON bodies parsed back. */
  function written(ctx: HttpContext): { status: number; body: unknown } {
    const raw = ctx.response.getBody()
    let body: unknown = raw
    if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    return { status: ctx.response.getStatus(), body }
  }

  it('routes a validation failure to the validation renderers', async () => {
    // rune and VineJS both raise `E_VALIDATION_ERROR` carrying `messages`.
    // Before this, they fell through to the generic renderer and the per-field
    // detail never reached the client.
    const ctx = ctxWith('application/json')
    await new ExceptionHandler().handle(
      new E_VALIDATION_ERROR([{ field: 'email', message: 'is required', rule: 'required' }]),
      ctx,
    )
    expect(written(ctx)).toEqual({
      status: 422,
      body: { errors: [{ field: 'email', message: 'is required', rule: 'required' }] },
    })
  })

  it('lets an app override renderErrorAsJSON', async () => {
    // The whole point: an override has to be reached. It was not, because the
    // renderers were private and `handle` called them directly.
    class Handler extends ExceptionHandler {
      override async renderErrorAsJSON(error: HttpError, ctx: HttpContext): Promise<void> {
        ctx.response.status(error.status).json({ mine: error.code })
      }
    }
    const ctx = ctxWith('application/json')
    await new Handler().handle(new Exception('boom', { status: 500, code: 'E_BOOM' }), ctx)
    expect(written(ctx)).toEqual({ status: 500, body: { mine: 'E_BOOM' } })
  })

  it('lets an app override renderValidationErrorAsJSON', async () => {
    class Handler extends ExceptionHandler {
      override async renderValidationErrorAsJSON(
        error: HttpError,
        ctx: HttpContext,
      ): Promise<void> {
        ctx.response.status(error.status).json({ fields: error.messages })
      }
    }
    const ctx = ctxWith('application/json')
    await new Handler().handle(new E_VALIDATION_ERROR([{ field: 'name' }]), ctx)
    expect(written(ctx)).toEqual({ status: 422, body: { fields: [{ field: 'name' }] } })
  })

  it('lets an app override renderError to bypass negotiation entirely', async () => {
    class Handler extends ExceptionHandler {
      override async renderError(error: HttpError, ctx: HttpContext): Promise<void> {
        ctx.response.status(error.status).send('always text')
      }
    }
    const ctx = ctxWith('text/html')
    await new Handler().handle(new Exception('boom', { status: 500 }), ctx)
    expect(written(ctx).body).toBe('always text')
  })

  it('renders validation failures as JSON:API when asked', async () => {
    const ctx = ctxWith('application/vnd.api+json')
    await new ExceptionHandler().handle(
      new E_VALIDATION_ERROR([
        { field: 'email', message: 'is required', rule: 'required', meta: { min: 3 } },
      ]),
      ctx,
    )
    expect(written(ctx)).toEqual({
      status: 422,
      body: {
        errors: [
          {
            title: 'is required',
            code: 'required',
            source: { pointer: 'email' },
            meta: { min: 3 },
          },
        ],
      },
    })
  })

  it('renders validation failures as HTML when asked', async () => {
    const ctx = ctxWith('text/html')
    await new ExceptionHandler().handle(
      new E_VALIDATION_ERROR([
        { field: 'email', message: 'is required' },
        { field: 'name', message: 'is too short' },
      ]),
      ctx,
    )
    expect(written(ctx).body).toBe('email - is required<br />name - is too short')
  })

  it('escapes validation text in the HTML renderer', async () => {
    const ctx = ctxWith('text/html')
    await new ExceptionHandler().handle(
      new E_VALIDATION_ERROR([{ field: 'bio', message: '<script>alert(1)</script>' }]),
      ctx,
    )
    expect(written(ctx).body).not.toContain('<script>')
  })

  it('survives a validation message that is not the expected shape', async () => {
    // The messages come from whichever validator the app wired; a renderer must
    // not throw while rendering someone else's error.
    const ctx = ctxWith('text/html')
    await expect(
      new ExceptionHandler().handle(new E_VALIDATION_ERROR([null, 'plain', 42]), ctx),
    ).resolves.toBeUndefined()
  })

  it('toHttpError keeps the thrown object itself, so instanceof still matches', async () => {
    // `ignoreExceptions` matches with instanceof, and a self-handling error has
    // to stay bound to its own instance. A copy would break both silently.
    class Probe extends ExceptionHandler {
      normalise(error: unknown): HttpError {
        return this.toHttpError(error)
      }
    }
    const thrown = new Exception('boom', { status: 503, code: 'E_BOOM' })
    const normalised = new Probe().normalise(thrown)
    expect(normalised).toBe(thrown)
    expect(normalised.status).toBe(503)
    expect(normalised.code).toBe('E_BOOM')
  })

  it('toHttpError gives a non-Error throw a status and a message', async () => {
    class Probe extends ExceptionHandler {
      normalise(error: unknown): HttpError {
        return this.toHttpError(error)
      }
    }
    const normalised = new Probe().normalise('just a string')
    expect(normalised.status).toBe(500)
    expect(normalised.message).toBe('just a string')
  })
})

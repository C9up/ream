import { describe, expect, it } from 'vitest'
import { createError, Exception, ExceptionHandler } from '../../src/http/Exception.js'
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
  class Probe extends ExceptionHandler {
    reportable(error: unknown): boolean {
      return this.shouldReport(error)
    }
    level(status: number): string {
      return this.getErrorLogLevel(status)
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

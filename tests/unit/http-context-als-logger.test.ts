import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function makeCtx(): HttpContext {
  const raw: RawRequest = { method: 'GET', path: '/', query: '', headers: {}, body: '' }
  return new HttpContext('req-1', raw, {}, { pattern: '/', middleware: [] })
}

describe('ream > HttpContext > ALS get/getOrFail (AdonisJS parity)', () => {
  it('get() is null and getOrFail() throws outside a request', () => {
    expect(HttpContext.get()).toBe(null)
    expect(() => HttpContext.getOrFail()).toThrow(/E_HTTP_CONTEXT_NOT_FOUND/)
  })

  it('run() makes the ctx the ambient context reachable down the stack', () => {
    const ctx = makeCtx()
    const seen = HttpContext.run(ctx, () => {
      // Simulate a deep call that never received ctx as an argument.
      const deep = () => HttpContext.getOrFail()
      expect(HttpContext.get()).toBe(ctx)
      return deep()
    })
    expect(seen).toBe(ctx)
    // Ambient context is cleared once run() returns.
    expect(HttpContext.get()).toBe(null)
  })
})

describe('ream > HttpContext > logger', () => {
  it('falls back to a console logger when no "logger" is registered', () => {
    const ctx = makeCtx()
    expect(typeof ctx.logger.info).toBe('function')
    expect(typeof ctx.logger.error).toBe('function')
    // Same instance on repeat access (built once).
    expect(ctx.logger).toBe(ctx.logger)
  })

  it('child-scopes the injected base logger to the request id', () => {
    const raw: RawRequest = { method: 'GET', path: '/', query: '', headers: {}, body: '' }
    const childCalls: Array<{ correlationId?: string }> = []
    const childLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, fatal() {} }
    const baseLogger = {
      ...childLogger,
      child(options: { correlationId?: string }) {
        childCalls.push(options)
        return childLogger
      },
    }
    // The base logger is resolved async by HttpKernel and injected via
    // setBaseLogger — the getter then child-scopes it synchronously.
    const ctx = new HttpContext('req-9', raw, {}, { pattern: '/', middleware: [] })
    ctx.setBaseLogger(baseLogger)
    expect(ctx.logger).toBe(childLogger)
    expect(childCalls).toEqual([{ correlationId: 'req-9' }])
  })
})

describe('HttpContext ambient-context switch (AdonisJS parity)', () => {
  it('reports whether tracking is on', () => {
    // On by default, where AdonisJS makes it opt-in — ream's own middleware
    // reads the ambient context.
    expect(HttpContext.usingAsyncLocalStorage).toBe(true)
  })

  it('answers null and throws once tracking is off', () => {
    const ctx = makeCtx()
    try {
      HttpContext.useAsyncLocalStorage(false)
      expect(HttpContext.usingAsyncLocalStorage).toBe(false)

      HttpContext.run(ctx, () => {
        // The callback still runs; only the tracking is gone.
        expect(HttpContext.get()).toBe(null)
        expect(() => HttpContext.getOrFail()).toThrow(/tracking is off/)
      })
    } finally {
      HttpContext.useAsyncLocalStorage(true)
    }
  })

  it('resumes tracking when turned back on', () => {
    const ctx = makeCtx()
    HttpContext.useAsyncLocalStorage(false)
    HttpContext.useAsyncLocalStorage(true)

    HttpContext.run(ctx, () => {
      expect(HttpContext.get()).toBe(ctx)
    })
  })
})

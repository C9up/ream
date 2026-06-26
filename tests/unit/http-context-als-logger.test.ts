import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function makeCtx(): HttpContext {
  const raw: RawRequest = { method: 'GET', path: '/', query: '', headers: {}, body: '' }
  return new HttpContext('req-1', raw, {}, { pattern: '/', middleware: [] })
}

describe('ream > HttpContext > ALS get/getOrFail (AdonisJS parity)', () => {
  it('get() is undefined and getOrFail() throws outside a request', () => {
    expect(HttpContext.get()).toBeUndefined()
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
    expect(HttpContext.get()).toBeUndefined()
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

  it('resolves and child-scopes a container "logger" to the request id', () => {
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
    const container = new Container()
    container.singleton('logger', () => baseLogger)
    const ctx = new HttpContext('req-9', raw, {}, { pattern: '/', middleware: [] }, container)
    expect(ctx.logger).toBe(childLogger)
    expect(childCalls).toEqual([{ correlationId: 'req-9' }])
  })
})

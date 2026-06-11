import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function ctxWith(headers: Record<string, string>): HttpContext {
  const raw: RawRequest = { method: 'GET', path: '/', query: '', headers, body: '' }
  return new HttpContext('t', raw, {}, { pattern: '/', middleware: [] })
}

describe('HttpContext > locale detection', () => {
  it('takes the primary subtag of the first Accept-Language entry', () => {
    expect(ctxWith({ 'accept-language': 'fr-CH,fr;q=0.9,en;q=0.8' }).locale).toBe('fr')
  })

  it('lowercases and strips the region', () => {
    expect(ctxWith({ 'accept-language': 'PT-BR' }).locale).toBe('pt')
  })

  it('defaults to en when the header is absent', () => {
    expect(ctxWith({}).locale).toBe('en')
  })

  it('remains a plain mutable field (middleware may override)', () => {
    const ctx = ctxWith({ 'accept-language': 'de' })
    expect(ctx.locale).toBe('de')
    ctx.locale = 'ja'
    expect(ctx.locale).toBe('ja')
  })
})

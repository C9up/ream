import { describe, expect, it } from 'vitest'
import { Response } from '../../src/http/Response.js'

describe('ream > Response.send() / json() — AdonisJS parity', () => {
  it('serves a plain string as text/plain and an HTML-looking string as text/html', () => {
    const plain = new Response()
    plain.send('This is the homepage.')
    expect(plain.getHeader('content-type')).toBe('text/plain; charset=utf-8')
    expect(plain.getBody()).toBe('This is the homepage.')

    const html = new Response()
    html.send('<p>Welcome</p>')
    expect(html.getHeader('content-type')).toBe('text/html; charset=utf-8')
    expect(html.getBody()).toBe('<p>Welcome</p>')
  })

  it('an explicitly set content-type wins over auto-detection', () => {
    const r = new Response()
    r.header('content-type', 'text/plain; charset=utf-8')
    r.send('<still plain>')
    expect(r.getHeader('content-type')).toBe('text/plain; charset=utf-8')
    expect(r.getBody()).toBe('<still plain>')
  })

  it('safe-stringifies BigInt in json() (native JSON.stringify throws)', () => {
    const r = new Response()
    r.json({ id: 9007199254740993n })
    expect(r.getHeader('content-type')).toBe('application/json')
    expect(JSON.parse(r.getBody())).toEqual({ id: '9007199254740993' })
  })

  it('drops circular references in an object send() instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const r = new Response()
    expect(() => r.send(cyclic)).not.toThrow()
    const parsed = JSON.parse(r.getBody())
    expect(parsed.name).toBe('x')
    expect(parsed.self).toBeUndefined()
  })
})

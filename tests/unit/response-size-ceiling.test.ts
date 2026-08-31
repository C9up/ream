/**
 * The response-size ceiling, on every path that can build a body.
 *
 * It lived only in `sendBuffer()`, so `json(hugeObject)` and `send(hugeString)`
 * walked straight past it — and the failure the ceiling exists to name (a
 * process that grows until it dies, with no message) came back through the
 * doors people actually use.
 */
import { describe, expect, it } from 'vitest'
import { Response } from '../../src/http/Response.js'

/** A response that refuses anything over 1 KB. */
const capped = () => {
  const res = new Response()
  res.setMaxBodyBytes(1024)
  return res
}

const big = 'x'.repeat(4096)

describe('Response > the ceiling covers every body path', () => {
  it('refuses an oversized json()', () => {
    expect(() => capped().json({ blob: big })).toThrow(/E_RESPONSE_TOO_LARGE/)
  })

  it('refuses an oversized send() of a string', () => {
    expect(() => capped().send(big)).toThrow(/E_RESPONSE_TOO_LARGE/)
  })

  it('refuses an oversized send() of an object', () => {
    expect(() => capped().send({ blob: big })).toThrow(/E_RESPONSE_TOO_LARGE/)
  })

  it('refuses an oversized jsonp()', () => {
    expect(() => capped().jsonp({ blob: big })).toThrow(/E_RESPONSE_TOO_LARGE/)
  })

  it('refuses an oversized buffer, as it always did', () => {
    expect(() => capped().sendBuffer(Buffer.alloc(4096))).toThrow(
      /E_RESPONSE_TOO_LARGE/,
    )
  })

  it('names the ceiling and the way past it', () => {
    try {
      capped().json({ blob: big })
      expect.unreachable('an oversized body has to be refused')
    } catch (error) {
      // A ceiling that fires without saying which knob raises it just moves
      // the mystery.
      expect((error as Error).message).toMatch(/maxResponseBytes/)
      expect((error as Error).message).toMatch(/archive/)
    }
  })
})

describe('Response > it measures bytes, not characters', () => {
  it('counts a multi-byte character for what it costs on the wire', () => {
    const res = new Response()
    res.setMaxBodyBytes(10)

    // Ten characters, thirty bytes: the string length would have passed.
    expect(() => res.send('é'.repeat(10))).toThrow(/E_RESPONSE_TOO_LARGE/)
  })

  it('lets a body that fits through', () => {
    const res = capped()

    expect(() => res.json({ ok: true })).not.toThrow()
    expect(res.getBody()).toContain('"ok":true')
  })
})

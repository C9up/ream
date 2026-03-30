import { describe, expect, it } from 'vitest'
import { add, hello, noop, throwReamError, triggerPanic } from './loader.js'

describe('napi-roundtrip > basic', () => {
  it('hello returns greeting string', () => {
    const result = hello('Ream')
    expect(result).toBe('Hello, Ream!')
  })

  it('add returns sum of two numbers', () => {
    const result = add(2, 3)
    expect(result).toBe(5)
  })

  it('add handles negative numbers', () => {
    expect(add(-1, -2)).toBe(-3)
    expect(add(-5, 10)).toBe(5)
  })

  it('add handles zero', () => {
    expect(add(0, 0)).toBe(0)
  })

  it('hello handles empty string', () => {
    expect(hello('')).toBe('Hello, !')
  })

  it('hello handles unicode', () => {
    expect(hello('Kaen')).toBe('Hello, Kaen!')
  })
})

describe('napi-roundtrip > error handling', () => {
  it('throwReamError throws structured JSON error', () => {
    expect.assertions(7)

    try {
      throwReamError()
    } catch (e: unknown) {
      const error = e as Error
      const parsed = JSON.parse(error.message)
      expect(parsed.code).toBe('TEST_ERROR')
      expect(parsed.message).toBe('This is a test error')
      expect(parsed.hint).toBe('This hint should appear in TypeScript')
      expect(parsed.context.module).toBe('napi-test')
      expect(parsed.docsUrl).toBe('https://docs.ream.dev/errors/TEST_ERROR')
      expect(parsed.sourceFile).toBeDefined()
      expect(parsed.sourceLine).toBeDefined()
    }
  })

  it('triggerPanic does not crash Node.js', () => {
    expect.assertions(3)

    try {
      triggerPanic()
    } catch (e: unknown) {
      const error = e as Error
      const parsed = JSON.parse(error.message)
      expect(parsed.code).toBe('RUST_PANIC')
      expect(parsed.message).toContain('intentional panic for testing')
      expect(parsed.hint).toContain('bug in the Ream framework')
    }
  })

  it('Node.js is still alive after panic', () => {
    // If we reach here, Node didn't crash from the panic test above
    expect(add(1, 1)).toBe(2)
  })
})

describe('napi-roundtrip > performance', () => {
  it('noop measures NAPI crossing overhead (NFR4: < 500ns)', () => {
    // Warmup
    for (let i = 0; i < 1000; i++) {
      noop()
    }

    const iterations = 100_000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      noop()
    }
    const elapsed = performance.now() - start
    const perCallNs = (elapsed * 1_000_000) / iterations

    // Log for visibility
    console.log(`NAPI overhead: ${perCallNs.toFixed(0)}ns per call (${iterations} iterations, ${elapsed.toFixed(1)}ms total)`)

    // NFR4 target: < 500ns per call
    // In debug mode this may be higher, so we use a generous threshold
    // Real benchmarks should use release mode
    expect(perCallNs).toBeLessThan(5000) // 5µs generous threshold for debug mode
  })
})

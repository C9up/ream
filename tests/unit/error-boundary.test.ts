import { describe, expect, it } from 'vitest'
import type { ErrorEvent } from '../../src/index.js'
import { ErrorBoundary } from '../../src/index.js'

describe('error boundary > service error', () => {
  it('emits service.error event', () => {
    const events: ErrorEvent[] = []
    const boundary = new ErrorBoundary((e) => events.push(e))

    boundary.serviceError('OrderService', new Error('DB connection failed'), 'corr-123')

    expect(events.length).toBe(1)
    expect(events[0].type).toBe('service.error')
    expect(events[0].source).toBe('OrderService')
    expect(events[0].message).toBe('DB connection failed')
    expect(events[0].correlationId).toBe('corr-123')
    expect(events[0].timestamp).toBeDefined()
  })
})

describe('error boundary > security rejected', () => {
  it('emits security.rejected event', () => {
    const events: ErrorEvent[] = []
    const boundary = new ErrorBoundary((e) => events.push(e))

    boundary.securityRejected('Blackhole', 'Rate limit exceeded', 'corr-456')

    expect(events.length).toBe(1)
    expect(events[0].type).toBe('security.rejected')
    expect(events[0].severity).toBe('warning')
    expect(events[0].message).toBe('Rate limit exceeded')
  })
})

describe('error boundary > system error', () => {
  it('emits system.error event', () => {
    const events: ErrorEvent[] = []
    const boundary = new ErrorBoundary((e) => events.push(e))

    boundary.systemError('NAPI', 'Crossing failed')

    expect(events.length).toBe(1)
    expect(events[0].type).toBe('system.error')
    expect(events[0].source).toBe('NAPI')
  })
})

describe('error boundary > handles non-Error objects', () => {
  it('converts string to error event', () => {
    const events: ErrorEvent[] = []
    const boundary = new ErrorBoundary((e) => events.push(e))

    boundary.serviceError('test', 'string error')

    expect(events[0].message).toBe('string error')
  })

  it('converts number to error event', () => {
    const events: ErrorEvent[] = []
    const boundary = new ErrorBoundary((e) => events.push(e))

    boundary.serviceError('test', 42)

    expect(events[0].message).toBe('42')
  })
})

describe('error boundary > emitter failure resilience', () => {
  it('does not throw if emitter fails', () => {
    const boundary = new ErrorBoundary(() => {
      throw new Error('emitter broken')
    })

    // Should not throw — writes to stderr instead
    expect(() => boundary.serviceError('test', 'error')).not.toThrow()
  })
})

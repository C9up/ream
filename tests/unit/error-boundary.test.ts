import { describe, expect, it, vi } from 'vitest'
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

  it('writes the failed event to stderr when the emitter throws', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    new ErrorBoundary(() => {
      throw new Error('x')
    }).serviceError('S', new Error('boom'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Failed to emit'))
    write.mockRestore()
  })
})

describe('error boundary > severity + originalError', () => {
  it('maps system.error to critical, service.error to warning', () => {
    const events: ErrorEvent[] = []
    const b = new ErrorBoundary((e) => events.push(e))
    b.systemError('infra', new Error('down'))
    b.serviceError('app', new Error('bug'))
    expect(events[0].severity).toBe('critical')
    expect(events[1].severity).toBe('warning')
  })

  it('carries the stack trace in originalError', () => {
    const events: ErrorEvent[] = []
    new ErrorBoundary((e) => events.push(e)).serviceError('S', new Error('with-stack'))
    expect(events[0].originalError).toContain('with-stack')
  })
})

describe('error boundary > dev-mode logging', () => {
  it('uses the ERROR prefix for a system error in dev mode', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    new ErrorBoundary(() => {}, true).systemError('DB', new Error('down'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('✗ ERROR [DB] down'))
    write.mockRestore()
  })

  it('uses the SECURITY prefix for a rejection in dev mode', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    new ErrorBoundary(() => {}, true).securityRejected('guard', 'nope')
    expect(write).toHaveBeenCalledWith(expect.stringContaining('⚠ SECURITY'))
    write.mockRestore()
  })

  it('uses the SERVICE prefix for a service error in dev mode', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    new ErrorBoundary(() => {}, true).serviceError('svc', new Error('e'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('✗ SERVICE'))
    write.mockRestore()
  })
})

describe('error boundary > install lifecycle', () => {
  it('install() is a no-op under the test runner and uninstall() is safe', () => {
    const b = new ErrorBoundary(() => {})
    expect(() => b.install()).not.toThrow()
    expect(() => b.install()).not.toThrow() // idempotent
    expect(() => b.uninstall()).not.toThrow()
  })
})

/**
 * Installing the boundary REPLACES Node's own handling of an unhandled
 * rejection, which prints the reason and exits. With an empty listener list —
 * the default — a fatal reached nothing at all in production, turning every
 * forgotten `await` from a loud crash into silence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../src/ErrorBoundary.js'

/**
 * Install for real and hand back the rejection handler.
 *
 * `install()` no-ops under vitest so per-test listeners do not pile up on the
 * singleton `process`, so the guard is lifted just long enough to register,
 * then the handler is detached and called directly.
 */
function installedRejectionHandler(boundary: ErrorBoundary): (reason: unknown) => void {
  const vitestFlag = process.env.VITEST
  const nodeEnv = process.env.NODE_ENV
  process.env.VITEST = 'false'
  process.env.NODE_ENV = 'production'
  try {
    boundary.install()
    const handlers = process.listeners('unhandledRejection')
    return handlers[handlers.length - 1] as (reason: unknown) => void
  } finally {
    boundary.uninstall()
    if (vitestFlag === undefined) delete process.env.VITEST
    else process.env.VITEST = vitestFlag
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  }
}

let stderr: string[] = []
function captureStderr(): void {
  stderr = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ream > fatal errors always surface', () => {
  it('writes an unhandled rejection to stderr even with no listener', () => {
    // An emitter that does nothing: an app that never called `onError`.
    const boundary = new ErrorBoundary(() => {}, false)
    const onRejection = installedRejectionHandler(boundary)
    captureStderr()
    onRejection(new Error('db pool exhausted'))
    expect(stderr.join('')).toContain('FATAL')
    expect(stderr.join('')).toContain('db pool exhausted')
  })

  it('includes the stack, which is what says where it came from', () => {
    const boundary = new ErrorBoundary(() => {}, false)
    const onRejection = installedRejectionHandler(boundary)
    captureStderr()
    onRejection(new Error('boom'))
    expect(stderr.join('')).toContain('error-boundary-fatal.test.ts')
  })

  it('still reaches a listener that IS registered', () => {
    const seen: string[] = []
    const boundary = new ErrorBoundary((e) => seen.push(e.message), false)
    const onRejection = installedRejectionHandler(boundary)
    captureStderr()
    onRejection(new Error('both paths'))
    expect(seen).toEqual(['both paths'])
    expect(stderr.join('')).toContain('both paths')
  })

  it('stays quiet for a non-fatal outside dev', () => {
    captureStderr()
    new ErrorBoundary(() => {}, false).serviceError('handler', new Error('recoverable'))
    expect(stderr).toEqual([])
  })
})

import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installGracefulShutdown } from '../../src/GracefulShutdown.js'

/**
 * The logger shape `installGracefulShutdown` takes, spied.
 *
 * Typed through the signature rather than as a bare `ReturnType<typeof vi.fn>`:
 * an untyped mock is `Mock<Procedure | Constructable>`, which does not satisfy
 * `(msg: string) => void` — so the spy did not fit the parameter it was
 * written for.
 */
interface LoggerSpy {
  info: Mock<(msg: string) => void>
  error: Mock<(msg: string) => void>
}

function makeLogger(): LoggerSpy {
  return { info: vi.fn<(msg: string) => void>(), error: vi.fn<(msg: string) => void>() }
}

describe('ream > installGracefulShutdown', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // process.exit would terminate the test process — neutralize it.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}__`)
    }) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it('runs the onShutdown callback and exits 0 on success', async () => {
    const logger = makeLogger()
    let drained = false
    const handle = installGracefulShutdown({
      onShutdown: async () => {
        drained = true
      },
      logger,
    })

    await expect(handle.trigger()).rejects.toThrow('__exit_0__')
    expect(drained).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/initiated/))
    expect(logger.info).toHaveBeenCalledWith('Shutdown complete')

    handle.cleanup()
  })

  it('logs and ignores subsequent triggers (idempotent)', async () => {
    const logger = makeLogger()
    const handle = installGracefulShutdown({
      onShutdown: async () => {},
      logger,
    })

    await expect(handle.trigger()).rejects.toThrow('__exit_0__')
    // Re-entry: shutdownInProgress=true → returns immediately without re-logging.
    const initialInfoCalls = logger.info.mock.calls.length
    await handle.trigger()
    expect(logger.info.mock.calls.length).toBe(initialInfoCalls)

    handle.cleanup()
  })

  it('logs and continues when the drain callback throws', async () => {
    const logger = makeLogger()
    const handle = installGracefulShutdown({
      onShutdown: async () => {
        throw new Error('drain-fail')
      },
      logger,
    })

    await expect(handle.trigger()).rejects.toThrow('__exit_1__')
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/drain-fail/))

    handle.cleanup()
  })

  it('forces shutdown after the drainTimeout expires', async () => {
    const logger = makeLogger()
    let resolveDrain: () => void = () => {}

    const handle = installGracefulShutdown({
      drainTimeout: 30,
      onShutdown: () =>
        new Promise<void>((resolve) => {
          resolveDrain = resolve
        }),
      logger,
    })

    await expect(handle.trigger()).rejects.toThrow('__exit_1__')
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Drain timeout exceeded/))
    // Resolve the dangling drain promise so vitest doesn't carry an
    // unresolved task into the next test.
    resolveDrain()
    handle.cleanup()
  })

  it('cleanup() removes the SIGTERM/SIGINT listeners', () => {
    const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')
    const handle = installGracefulShutdown({ onShutdown: async () => {} })
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1)
    expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1)
    handle.cleanup()
    const after = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT')
    expect(after).toBe(before)
  })
})

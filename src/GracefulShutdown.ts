/**
 * Graceful Shutdown — handles SIGTERM/SIGINT with drain timeout.
 *
 * @implements FR82
 */

export interface ShutdownOptions {
  /** Maximum time to wait for drain in ms (default: 30000). */
  drainTimeout?: number
  /** Callback to execute during shutdown. */
  onShutdown: () => Promise<void>
  /** Optional logger. */
  logger?: { info: (msg: string) => void; error: (msg: string) => void }
}

export interface ShutdownHandle {
  /** Manually trigger shutdown (for testing). */
  trigger: () => Promise<void>
  /** Remove signal listeners (for testing cleanup). */
  cleanup: () => void
}

/**
 * Install graceful shutdown handlers for SIGTERM and SIGINT.
 * Returns a handle to manually trigger shutdown or clean up listeners.
 */
export function installGracefulShutdown(options: ShutdownOptions): ShutdownHandle {
  const drainTimeout = options.drainTimeout ?? 30_000
  const logger = options.logger ?? { info: () => {}, error: () => {} }
  let shutdownInProgress = false

  const shutdown = async () => {
    if (shutdownInProgress) return
    shutdownInProgress = true

    logger.info('Graceful shutdown initiated...')

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const drainPromise = options.onShutdown().catch((err) => {
      logger.error(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`)
    })

    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        logger.error(`Drain timeout exceeded (${drainTimeout}ms) — forcing shutdown`)
        resolve()
      }, drainTimeout)
    })

    await Promise.race([drainPromise, timeoutPromise])
    if (timeoutHandle) clearTimeout(timeoutHandle)

    logger.info('Shutdown complete')
    process.exit(0)
  }

  const onSigterm = () => { shutdown().catch((err) => { logger.error(`Fatal: ${err}`); process.exit(1) }) }
  const onSigint = () => { shutdown().catch((err) => { logger.error(`Fatal: ${err}`); process.exit(1) }) }

  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  const cleanup = () => {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }

  return { trigger: shutdown, cleanup }
}

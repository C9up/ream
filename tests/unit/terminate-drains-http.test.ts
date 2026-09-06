import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Application } from '../../src/Application.js'
import type { HttpKernelRequest, HttpKernelResponse } from '../../src/HttpKernel.js'
import type { HyperServerLike } from '../../src/index.js'
import { Ignitor } from '../../src/index.js'

/**
 * Terminating an application has to take the HTTP server with it.
 *
 * `terminate()` shut the providers down and called `process.exit(0)`. The
 * socket, the error boundary and the service locators belong to the Ignitor,
 * so none of them was released — and the exit could win the race against a
 * drain another path had already started, which is exactly what the documented
 * `app.listen('SIGTERM', () => app.terminate())` set up.
 *
 * Upstream solves it with `terminating` hooks: whoever opens the socket
 * registers the close, and terminate runs them in reverse before shutting the
 * providers down. It does not exit the process either.
 */

class CountingServer implements HyperServerLike {
  closes = 0
  constructor(private readonly boundPort: number) {}
  onRequest(_cb: (req: HttpKernelRequest) => Promise<HttpKernelResponse>): void {}
  async listen(): Promise<void> {}
  async port(): Promise<number> {
    return this.boundPort
  }
  async close(): Promise<void> {
    this.closes += 1
  }
}

function bootable() {
  let server: CountingServer | undefined
  const shutdowns: string[] = []
  let application: Application | undefined
  const ignitor = new Ignitor({
    port: 34523,
    serverFactory: (p) => {
      server = new CountingServer(p)
      return server
    },
    gracefulShutdown: false,
  })
    .httpServer()
    .tap((a) => {
      application = a
    })
    .provider(() => ({
      async shutdown(): Promise<void> {
        shutdowns.push('provider')
      },
    }))
  return {
    ignitor,
    server: () => server,
    shutdowns,
    app: (): Application => {
      if (!application) throw new Error('the application was never tapped')
      return application
    },
  }
}

describe('application > terminate', () => {
  it('closes the HTTP server, not just the providers', async () => {
    const { ignitor, server, shutdowns, app } = bootable()
    await ignitor.start()
    expect(server()?.closes).toBe(0)

    await app().terminate()

    expect(server()?.closes).toBe(1)
    expect(shutdowns).toEqual(['provider'])
  })

  it('terminates once when two paths fire together', async () => {
    // A SIGTERM handler and a crash handler racing must not close the socket
    // twice, nor shut a connection pool down twice.
    const { ignitor, server, shutdowns, app } = bootable()
    await ignitor.start()

    await Promise.all([app().terminate(), app().terminate()])

    expect(server()?.closes).toBe(1)
    expect(shutdowns).toEqual(['provider'])
  })

  it('runs terminating hooks in reverse, last registered first', async () => {
    const order: string[] = []
    const app = new Application()
    app.setAppRoot(new URL('file:///project/'))
    app.terminating(() => {
      order.push('first')
    })
    app.terminating(() => {
      order.push('second')
    })

    await app.terminate()

    // Last opened, first closed — the order a resource stack needs.
    expect(order).toEqual(['second', 'first'])
  })
})

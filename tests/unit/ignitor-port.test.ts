import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import type { HttpKernelRequest, HttpKernelResponse, HyperServerLike } from '../../src/index.js'
import { Ignitor } from '../../src/index.js'

/**
 * Where the bind port comes from, and WHEN it is read.
 *
 * `#start/env` is imported in `booting()` — that import is what loads `.env`
 * into `process.env`. Anything reading PORT before then reads the shell's
 * environment only, so a PORT set in `.env` bound nothing while every later
 * reader (the boot banner) reported it. The server said 3007 and listened on
 * 3000.
 */

class MockServer implements HyperServerLike {
  readonly boundPort: number
  constructor(port: number) {
    this.boundPort = port
  }
  onRequest(_cb: (req: HttpKernelRequest) => Promise<HttpKernelResponse>): void {}
  async listen(): Promise<void> {}
  async port(): Promise<number> {
    return this.boundPort
  }
  async close(): Promise<void> {}
}

function mockFactory() {
  let srv: MockServer | undefined
  return {
    factory: (p: number): HyperServerLike => {
      srv = new MockServer(p)
      return srv
    },
    boundPort: (): number => {
      if (!srv) throw new Error('server not created yet')
      return srv.boundPort
    },
  }
}

const previousPort = process.env.PORT

afterEach(() => {
  if (previousPort === undefined) delete process.env.PORT
  else process.env.PORT = previousPort
})

describe('ignitor > bind port', () => {
  it('reads a PORT that only exists once booting() has run', async () => {
    delete process.env.PORT
    const { factory, boundPort } = mockFactory()
    const ignitor = new Ignitor({ serverFactory: factory, gracefulShutdown: false })
      .httpServer()
      // Exactly what a scaffolded bin/server.ts does: `#start/env` is imported
      // here, and importing it is what puts .env into process.env.
      .tap((app) => {
        app.booting(async () => {
          process.env.PORT = '34517'
        })
      })
    const app = await ignitor.start()
    expect(boundPort()).toBe(34517)
    // And the accessor agrees with the socket, so a banner built from it
    // cannot contradict what was bound.
    expect(await app.port()).toBe(34517)
    await app.stop()
  })

  it('lets an explicit port win over the environment', async () => {
    // A harness booting several applications in one process has already picked
    // an ephemeral port for each; the environment must not override that.
    process.env.PORT = '34517'
    const { factory, boundPort } = mockFactory()
    const app = await new Ignitor({
      port: 34518,
      serverFactory: factory,
      gracefulShutdown: false,
    })
      .httpServer()
      .start()
    expect(boundPort()).toBe(34518)
    await app.stop()
  })

  it('falls back to 3000 when nothing sets a port', async () => {
    delete process.env.PORT
    const { factory, boundPort } = mockFactory()
    const app = await new Ignitor({ serverFactory: factory, gracefulShutdown: false })
      .httpServer()
      .start()
    // Dev mode may step past an occupied 3000, so assert the base, not equality.
    expect(boundPort()).toBeGreaterThanOrEqual(3000)
    expect(boundPort()).toBeLessThan(3020)
    await app.stop()
  })

  it('refuses a PORT that is not a port, by name', async () => {
    process.env.PORT = 'eighty'
    const { factory } = mockFactory()
    await expect(
      new Ignitor({ serverFactory: factory, gracefulShutdown: false }).httpServer().start(),
    ).rejects.toThrow(/PORT must be an integer/)
  })
})

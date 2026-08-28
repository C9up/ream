/**
 * Test utilities, in the shape AdonisJS gives them: `testUtils.httpServer()`
 * starts the application's HTTP server for a test run and hands back the
 * function that closes it.
 *
 *   // tests/bootstrap.ts
 *   configureSuite(suite) {
 *     if (['functional', 'e2e'].includes(suite.name)) {
 *       return suite.setup(() => testUtils.httpServer().start())
 *     }
 *   }
 *
 * The point of the shape is WHERE the server starts. A suite that does not
 * declare the hook never starts one, so a unit suite pays nothing — which is
 * the same saving a lazily-booted client buys, obtained by scoping instead of
 * by deferring, and obtained per SUITE rather than per file.
 *
 * `start()` returning its own teardown is what makes it a one-liner in a hook:
 * a setup hook may return its undo, so there is no matching `teardown` to
 * write and no way to forget it.
 */

import { TestClient } from './TestClient.js'

/** Boots the app on `port` and reports the port it bound plus how to stop it. */
export type BootServer = (
  port: number,
) => Promise<{ port: number; close: () => Promise<void> | void }>

/**
 * What `testUtils.httpServer()` returns — AdonisJS `HttpServerUtils`.
 */
export class HttpServerUtils {
  readonly #boot: BootServer
  readonly #onStarted: (client: TestClient) => void

  constructor(boot: BootServer, onStarted: (client: TestClient) => void) {
    this.#boot = boot
    this.#onStarted = onStarted
  }

  /**
   * Start the server. Returns the function that closes it, so a setup hook can
   * return this call directly.
   */
  async start(): Promise<() => Promise<void>> {
    const client = new TestClient(this.#boot)
    await client.boot()
    this.#onStarted(client)
    return () => client.close()
  }
}

/**
 * The utilities themselves — AdonisJS `TestUtils`.
 *
 * Constructed with how to boot the app, because ream has no ambient
 * application to reach for: the app is whatever the test bootstrap hands over.
 * That is the one place this differs from AdonisJS, where `testUtils` is a
 * service resolved from the container and already knows its app.
 */
export class TestUtils {
  readonly #boot: BootServer
  #client: TestClient | undefined

  constructor(boot: BootServer) {
    this.#boot = boot
  }

  /** Start/stop the HTTP server for a suite. */
  httpServer(): HttpServerUtils {
    return new HttpServerUtils(this.#boot, (client) => {
      this.#client = client
    })
  }

  /**
   * The client for the server this run started, or `undefined` before
   * `httpServer().start()`. A plugin reads it to put a client on the test
   * context without booting a second server.
   */
  client(): TestClient | undefined {
    return this.#client
  }
}

/** Build the utilities for an app booted by `boot`. */
export function createTestUtils(boot: BootServer): TestUtils {
  return new TestUtils(boot)
}

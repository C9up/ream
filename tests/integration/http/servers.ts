/**
 * Every native server a test starts is closed after that test, pass or fail.
 *
 * Closing inline after the assertions left the server listening whenever an
 * `expect` threw first: a bound socket and tokio threads for the rest of the
 * worker's life, inherited by the next file in the same worker. `close()` is
 * idempotent, so a test that also closes its server itself is unaffected.
 */
import { afterEach } from 'vitest'

interface Closable {
  close(): Promise<void>
}

const open = new Set<Closable>()

/** Register `server` to be closed after the current test. */
export function track<T extends Closable>(server: T): T {
  open.add(server)
  return server
}

afterEach(async () => {
  const servers = [...open]
  open.clear()
  await Promise.allSettled(servers.map((server) => server.close()))
})

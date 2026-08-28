import { describe, expect, it } from 'vitest'
import { TestClient } from '../../src/testing/TestClient.js'

/**
 * The client used to boot at construction time, via an explicit `boot()` the
 * caller had to remember. A test runner that installs it for every file then
 * starts a server for files that never issue a request — measured at ~400ms
 * each, which on a campaign of a hundred files is most of its runtime.
 *
 * A request boots on its own now, so a file that makes none pays nothing.
 */
function fakeBoot() {
  let boots = 0
  let closes = 0
  const fn = async (): Promise<{ port: number; close: () => void }> => {
    boots += 1
    return { port: 4000 + boots, close: () => { closes += 1 } }
  }
  return {
    fn,
    get boots() { return boots },
    get closes() { return closes },
  }
}

describe('TestClient > lazy boot', () => {
  it('starts nothing until something asks for it', () => {
    const boot = fakeBoot()
    const client = new TestClient(boot.fn)
    // Building a request is not issuing one — the builder is lazy too.
    client.get('/health')
    expect(boot.boots).toBe(0)
    expect(client.booted).toBe(false)
    expect(client.port).toBe(0)
  })

  it('boots exactly once, however many callers race for it', async () => {
    const boot = fakeBoot()
    const client = new TestClient(boot.fn)
    await Promise.all([client.boot(), client.boot(), client.boot()])
    expect(boot.boots).toBe(1)
    expect(client.booted).toBe(true)
    // The port is the one THIS boot bound, not a stale read.
    expect(client.port).toBe(4001)
  })

  it('closes without starting anything when no request was made', async () => {
    const boot = fakeBoot()
    const client = new TestClient(boot.fn)
    await client.close()
    expect(boot.boots).toBe(0)
    expect(boot.closes).toBe(0)
  })

  it('reboots after a close, on a fresh port', async () => {
    const boot = fakeBoot()
    const client = new TestClient(boot.fn)
    await client.boot()
    expect(client.port).toBe(4001)
    await client.close()
    // Closed means closed: the port is released, not remembered.
    expect(client.booted).toBe(false)
    expect(client.port).toBe(0)
    await client.boot()
    expect(boot.boots).toBe(2)
    expect(client.port).toBe(4002)
  })

  it('does not leave a server running when close races an in-flight boot', async () => {
    const boot = fakeBoot()
    const client = new TestClient(boot.fn)
    // Not awaited: close arrives while the boot is still settling. Without
    // awaiting it first, close would find `#server` still null and leave the
    // server the boot is about to assign running with nobody holding it.
    const booting = client.boot()
    await client.close()
    await booting
    expect(boot.boots).toBe(1)
    expect(boot.closes).toBe(1)
    expect(client.booted).toBe(false)
  })
})

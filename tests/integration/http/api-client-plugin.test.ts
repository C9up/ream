/**
 * The `apiClient()` helix plugin (Japa `@japa/api-client` parity): calling the
 * plugin registers a BOOTED TestClient on the context as `client`. Exercised
 * against a trivial Node server via a mock PluginApi (no helix runtime needed).
 */

import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { apiClient, TestClient } from '../../../src/testing/TestClient.js'

function makeServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    } else {
      res.writeHead(404)
      res.end('nope')
    }
  })
  const boot = (port: number) =>
    new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      server.listen(port, () => {
        const addr = server.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : port
        resolve({
          port: actualPort,
          close: () => new Promise<void>((r) => server.close(() => r())),
        })
      })
    })
  return { boot }
}

describe('helix plugin > apiClient()', () => {
  it('registers a booted client on the context', async () => {
    const { boot } = makeServer()

    // Mock PluginApi — capture what the plugin registers under `client`.
    let registered: TestClient | undefined
    const api = {
      context: {
        macro(name: string, value: unknown) {
          if (name === 'client' && value instanceof TestClient) registered = value
        },
        getter() {},
      },
    }

    await apiClient({ boot })(api)

    if (!registered) throw new Error('apiClient did not register a `client`')

    // The verb shortcut returns the thenable low-level builder (awaiting sends).
    const ok = await registered.get('/health')
    expect(ok.status).toBe(200)
    expect(ok.json()).toEqual({ ok: true })

    // The rich builder (fluent) carries the japa assertion surface.
    await registered.fluent('GET', '/health').assertOk()
    await registered.fluent('GET', '/health').assertBody({ ok: true })
    await registered.fluent('GET', '/missing').assertNotFound()

    await registered.close()
  })
})

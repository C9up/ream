import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { HyperServer } from './loader.js'
import { rawField } from './napi-request.js'

/**
 * The guards the native server applies before a request reaches JS, driven
 * through the NAPI `HyperServer` contract: client IP behind proxies, cookie
 * duplicates, the path-traversal shield, body limits and connection timeouts.
 */
const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

type Configure = (server: HyperServer) => void

async function serve(
  echo: (raw: Record<string, unknown>) => string,
  configure: Configure = () => {},
): Promise<{ port: number; calls: () => number; close: () => Promise<void> }> {
  const server = new HyperServer(0)
  let calls = 0
  configure(server)
  server.onRequest(async (raw) => {
    calls += 1
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: echo(raw) }
  })
  await server.listen()
  const port = await server.port()
  return { port, calls: () => calls, close: () => server.close() }
}

/** Send raw bytes; resolve with what came back once the server answered or closed. */
function rawExchange(port: number, payload: string, waitMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    const done = () => {
      socket.destroy()
      resolve(received)
    }
    const timer = setTimeout(done, waitMs)
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (received.includes('\r\n\r\n') && received.endsWith('}}')) {
        clearTimeout(timer)
        done()
      }
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(received)
    })
    socket.on('error', () => {})
    socket.write(payload)
  })
}

function ipsOf(raw: Record<string, unknown>): string[] {
  const value = rawField(raw, 'ips')
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

describeIfNetwork('native server > client IP behind proxies', () => {
  it('ignores the client-chosen left-most X-Forwarded-For entry', async () => {
    const { port, close } = await serve(
      (raw) => `${String(rawField(raw, 'ip'))}|${ipsOf(raw).join(',')}`,
      (server) => server.configureTrustedProxies(['127.0.0.1']),
    )
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
    })
    expect(await res.text()).toBe('203.0.113.9|127.0.0.1,203.0.113.9')
    await close()
  })

  it('ignores X-Real-IP', async () => {
    const { port, close } = await serve(
      (raw) => String(rawField(raw, 'ip')),
      (server) => server.configureTrustedProxies(['loopback']),
    )
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-real-ip': '6.6.6.6' } })
    expect(await res.text()).toBe('127.0.0.1')
    await close()
  })

  it('refuses a trusted-proxy entry that is not an address or a range', () => {
    const server = new HyperServer(0)
    expect(() => server.configureTrustedProxies(['10.0.0/8'])).toThrow(/INVALID_TRUSTED_PROXY/)
  })
})

describeIfNetwork('native server > cookies', () => {
  it('keeps the first value of a duplicated cookie name', async () => {
    const { port, close } = await serve((raw) => {
      const cookies = rawField(raw, 'cookies')
      return typeof cookies === 'object' && cookies !== null
        ? String(Reflect.get(cookies, 'session'))
        : ''
    })
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: 'session=legit-host-only; session=tossed-by-sibling-subdomain' },
    })
    expect(await res.text()).toBe('legit-host-only')
    await close()
  })
})

describeIfNetwork('native server > shield', () => {
  it('refuses half-encoded dot-dot segments', async () => {
    const { port, calls, close } = await serve(
      () => 'reached',
      (server) => server.configureShield({ pathTraversal: true, paramPollution: true }),
    )
    for (const path of ['/static/.%2e/etc/passwd', '/static/%2e./etc/passwd']) {
      const response = await rawExchange(
        port,
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      )
      expect(response).toMatch(/^HTTP\/1\.1 400/)
      expect(response).toContain('E_PATH_TRAVERSAL')
    }
    expect(calls()).toBe(0)
    await close()
  })
})

describeIfNetwork('native server > body limits', () => {
  /** The marker and how much body reached JS, as a JSON body ending in `}}`. */
  const overLimit = (raw: Record<string, unknown>) =>
    JSON.stringify({
      seen: {
        tooLarge: rawField(raw, 'bodyTooLarge') === true,
        length: String(rawField(raw, 'body')).length,
      },
    })

  it('hands over a declared length over the limit without reading the body', async () => {
    const { port, calls, close } = await serve(overLimit)
    const response = await rawExchange(
      port,
      'POST /missing HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 41943040\r\n\r\n',
    )
    expect(response).toMatch(/^HTTP\/1\.1 200/)
    expect(response).toContain('{"seen":{"tooLarge":true,"length":0}}')
    expect(calls()).toBe(1)
    await close()
  })

  it('applies the configured per-type limits', async () => {
    const { port, close } = await serve(overLimit, (server) =>
      server.configureBodyLimits({ json: { limit: 32 }, raw: { limit: 4096 } }),
    )
    const json = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x'.repeat(100) }),
    })
    expect(await json.json()).toEqual({ seen: { tooLarge: true, length: 0 } })
    const text = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(2000),
    })
    expect(await text.json()).toEqual({ seen: { tooLarge: false, length: 2000 } })
    await close()
  })

  it('lets an uploading client read the answer instead of a reset connection', async () => {
    const { port, close } = await serve(overLimit)
    const res = await fetch(`http://127.0.0.1:${port}/missing`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.alloc(4 * 1024 * 1024, 0x61),
    })
    expect(await res.json()).toEqual({ seen: { tooLarge: true, length: 0 } })
    await close()
  })

  it('refuses a negative limit', () => {
    const server = new HyperServer(0)
    expect(() => server.configureBodyLimits({ json: { limit: -1 } })).toThrow(/INVALID_BODY_LIMIT/)
    expect(() => server.configureBodyLimits({ multipart: { maxFields: -1 } })).toThrow(
      /INVALID_BODY_LIMIT/,
    )
  })

  /** A multipart body of `fields` empty text parts and `files` one-byte files. */
  function multipart(fields: number, files: number): FormData {
    const form = new FormData()
    for (let i = 0; i < fields; i += 1) form.append(`f${i}`, '')
    for (let i = 0; i < files; i += 1) form.append(`u${i}`, new Blob(['x']), `u${i}.txt`)
    return form
  }

  const parts = (raw: Record<string, unknown>) => {
    const payload = rawField(raw, 'multipart')
    const count = (key: string): number => {
      if (typeof payload !== 'object' || payload === null) return -1
      const list: unknown = Reflect.get(payload, key)
      return Array.isArray(list) ? list.length : -1
    }
    return JSON.stringify({
      seen: {
        tooLarge: rawField(raw, 'bodyTooLarge') === true,
        fields: count('fields'),
        files: count('files'),
      },
    })
  }

  it('stops parsing a multipart body at the first part past maxFields or maxFiles', async () => {
    const { port, close } = await serve(parts, (server) =>
      server.configureBodyLimits({ multipart: { maxFields: 2, maxFiles: 2 } }),
    )
    try {
      const post = async (form: FormData) =>
        (await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: form })).json()

      expect(await post(multipart(2, 2))).toEqual({
        seen: { tooLarge: false, fields: 2, files: 2 },
      })
      expect(await post(multipart(3, 0))).toEqual({
        seen: { tooLarge: true, fields: -1, files: -1 },
      })
      expect(await post(multipart(0, 3))).toEqual({
        seen: { tooLarge: true, fields: -1, files: -1 },
      })
    } finally {
      await close()
    }
  })

  it('never ships a body of hundreds of thousands of empty parts to JavaScript', async () => {
    // The default bound is 1000 fields: the parse stops at part 1001 instead
    // of parsing, encoding and converting every one of them first.
    const { port, close } = await serve(parts)
    const part = '--B\r\nContent-Disposition: form-data; name="f"\r\n\r\n\r\n'
    const body = `${part.repeat(350_000)}--B--\r\n`
    expect(body.length).toBeLessThan(20 * 1024 * 1024)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=B' },
        body,
      })
      expect(await res.json()).toEqual({ seen: { tooLarge: true, fields: -1, files: -1 } })
    } finally {
      await close()
    }
  })
})

describeIfNetwork('native server > connection timeouts', () => {
  it('closes a connection whose headers never finish', async () => {
    const { port, close } = await serve(
      () => 'reached',
      (server) => server.configureConnections({ headersTimeout: 300 }),
    )
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 5000)
      socket.on('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.on('error', () => {})
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nX-Slow: ')
    })
    expect(closed).toBe(true)
    await close()
  })

  it('answers 408 to a body that does not arrive in time', async () => {
    const { port, calls, close } = await serve(
      () => 'reached',
      (server) => server.configureConnections({ requestTimeout: 300 }),
    )
    const response = await rawExchange(
      port,
      'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\nshort',
      5000,
    )
    expect(response).toMatch(/^HTTP\/1\.1 408/)
    expect(calls()).toBe(0)
    await close()
  })
})

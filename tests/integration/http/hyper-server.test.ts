import { describe, expect, it } from 'vitest'
import { HyperServer } from './loader.js'

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text() }
}

async function httpPost(
  port: number,
  path: string,
  body: string,
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

async function createServer(
  handler: (reqJson: string) => Promise<string>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = new HyperServer(0)
  server.onRequest(handler)
  await server.listen()
  const port = await server.port()
  return { port, close: () => server.close() }
}

describe('hyper-server > basic', () => {
  it('starts and serves HTTP via NAPI (MVP 0 gate test)', async () => {
    const { port, close } = await createServer(async () => {
      return JSON.stringify({ status: 200, body: 'hello from Ream' })
    })

    const res = await httpGet(port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello from Ream')

    await close()
  })

  it('callback receives correct method, path, and headers', async () => {
    const { port, close } = await createServer(async (reqJson: string) => {
      const req = JSON.parse(reqJson)
      return JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
    })

    const res = await httpPost(port, '/api/orders?page=1', '{"name":"test"}')
    expect(res.status).toBe(200)

    const receivedReq = JSON.parse(res.body)
    expect(receivedReq.method).toBe('POST')
    expect(receivedReq.path).toBe('/api/orders')
    expect(receivedReq.query).toBe('page=1')
    expect(receivedReq.body).toBe('{"name":"test"}')
    expect(receivedReq.headers['content-type']).toBe('application/json')

    await close()
  })

  it('response from callback is sent back correctly', async () => {
    const { port, close } = await createServer(async () => {
      return JSON.stringify({
        status: 201,
        headers: { 'x-custom': 'value' },
        body: '{"id":"123"}',
      })
    })

    const res = await fetch(`http://127.0.0.1:${port}/create`)
    expect(res.status).toBe(201)
    expect(res.headers.get('x-custom')).toBe('value')
    expect(await res.text()).toBe('{"id":"123"}')

    await close()
  })
})

describe('hyper-server > concurrency', () => {
  it('handles multiple concurrent requests', async () => {
    let requestCount = 0

    const { port, close } = await createServer(async () => {
      requestCount++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return JSON.stringify({ status: 200, body: `req-${requestCount}` })
    })

    const promises = Array.from({ length: 10 }, (_, i) => httpGet(port, `/test-${i}`))
    const results = await Promise.all(promises)

    for (const res of results) {
      expect(res.status).toBe(200)
    }
    expect(requestCount).toBe(10)

    await close()
  })
})

describe('hyper-server > lifecycle', () => {
  it('port 0 binds to random port', async () => {
    const { port, close } = await createServer(async () =>
      JSON.stringify({ status: 200, body: 'ok' }),
    )

    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)

    await close()
  })

  it('close shuts down cleanly', async () => {
    const { port, close } = await createServer(async () =>
      JSON.stringify({ status: 200, body: 'ok' }),
    )

    const res = await httpGet(port, '/')
    expect(res.status).toBe(200)

    await close()

    await new Promise((resolve) => setTimeout(resolve, 100))

    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    } catch {
      // Expected — connection refused
    }
  })
})

describe('hyper-server > error handling', () => {
  it('errors in callback do not crash the server', async () => {
    let callCount = 0

    const { port, close } = await createServer(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('handler error')
      }
      return JSON.stringify({ status: 200, body: 'recovered' })
    })

    const res1 = await httpGet(port, '/fail')
    expect(res1.status).toBe(500)

    const res2 = await httpGet(port, '/ok')
    expect(res2.status).toBe(200)
    expect(res2.body).toBe('recovered')

    await close()
  })
})

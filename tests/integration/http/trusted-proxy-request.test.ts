import { describe, expect, it } from 'vitest'
import { Request } from '../../../src/http/Request.js'
import { HyperServer } from './loader.js'
import { asRequest, rawField } from './napi-request.js'
import { track } from './servers.js'

/**
 * `request.protocol()` / `secure()` / `host()` / `ips()` over the real native
 * server: the forwarded headers count only when the socket peer is one of the
 * configured trusted proxies. The test client connects from 127.0.0.1.
 */
const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : undefined
}

async function seenBy(trustedProxies: string[], headers: Record<string, string>) {
  const server = track(new HyperServer(0))
  if (trustedProxies.length > 0) server.configureTrustedProxies(trustedProxies)
  server.onRequest(async (raw) => {
    const ipValue = rawField(raw, 'ip')
    const request = new Request({
      ...asRequest(raw),
      ip: typeof ipValue === 'string' ? ipValue : undefined,
      ips: strings(rawField(raw, 'ips')),
      peerTrusted: rawField(raw, 'peerTrusted') === true,
    })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: request.protocol(),
        secure: request.secure(),
        host: request.host(),
        ip: request.ip(),
        ips: request.ips(),
      }),
    }
  })
  await server.listen()
  try {
    const port = await server.port()
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers })
    const body: unknown = await response.json()
    return body
  } finally {
    await server.close()
  }
}

const forwarded = {
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'public.example.com',
  'x-forwarded-for': '6.6.6.6, 203.0.113.9',
}

describeIfNetwork('native server > forwarded headers follow the trusted proxies', () => {
  it('honours them when the peer is a trusted proxy', async () => {
    expect(await seenBy(['127.0.0.1'], forwarded)).toEqual({
      protocol: 'https',
      secure: true,
      host: 'public.example.com',
      ip: '203.0.113.9',
      // 6.6.6.6 was written by the client: 203.0.113.9 is not a trusted proxy.
      ips: ['127.0.0.1', '203.0.113.9'],
    })
  })

  it('ignores them when the peer is not a trusted proxy', async () => {
    const seen = await seenBy(['10.0.0.0/8'], forwarded)
    expect(seen).toMatchObject({
      protocol: 'http',
      secure: false,
      ip: '127.0.0.1',
      ips: ['127.0.0.1'],
    })
    expect(seen).not.toMatchObject({ host: 'public.example.com' })
  })

  it('honours a trusted proxy that forwards the scheme and host without X-Forwarded-For', async () => {
    expect(
      await seenBy(['127.0.0.1'], {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'public.example.com',
      }),
    ).toEqual({
      protocol: 'https',
      secure: true,
      host: 'public.example.com',
      ip: '127.0.0.1',
      ips: ['127.0.0.1'],
    })
  })

  it('ignores them when no proxy is trusted', async () => {
    expect(await seenBy([], forwarded)).toMatchObject({
      protocol: 'http',
      secure: false,
      ips: ['127.0.0.1'],
    })
  })
})

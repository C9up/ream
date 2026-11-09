/**
 * `@c9up/ream/http-client`: outbound HTTP that cannot be pointed at the
 * server's own network.
 *
 * The local test server listens on 127.0.0.1 — exactly the kind of address
 * the guard refuses — so reaching it at all needs `allowHosts`, and the
 * refusals are tested against it without it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isReamError } from '../../src/errors/ReamError.js'
import {
  fakeHttp,
  HttpClient,
  HttpClientError,
  isPublicAddress,
} from '../../src/http-client/index.js'

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

let server: Server
let port: number
const routes = new Map<string, Handler>()
const seen: Array<{
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const handler = routes.get(req.url ?? '')
      if (handler) handler(req, res, body)
      else res.writeHead(404).end('missing')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  port = (address satisfies AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A client allowed to reach the local server under both of its names. */
function localClient(options: ConstructorParameters<typeof HttpClient>[0] = {}): HttpClient {
  return new HttpClient({ allowHosts: [`127.0.0.1:${port}`, `localhost:${port}`], ...options })
}

async function failure(promise: Promise<unknown>): Promise<HttpClientError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof HttpClientError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

describe('isPublicAddress', () => {
  const refused = [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.51.100.7',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.5',
    '::ffff:7f00:1',
    '64:ff9b::a00:5',
    '2002:a00:5::1',
    '2001:db8::1',
    'not-an-ip',
  ]
  for (const address of refused) {
    it(`refuses ${address}`, () => {
      expect(isPublicAddress(address)).toBe(false)
    })
  }

  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    it(`accepts ${address}`, () => {
      expect(isPublicAddress(address)).toBe(true)
    })
  }
})

describe('HttpClient > the public-address rule', () => {
  it('refuses an address literal in the URL before connecting', async () => {
    const error = await failure(new HttpClient().get(`http://127.0.0.1:${port}/ok`))
    expect(error.reason).toBe('privateAddress')
    expect(error.code).toBe('E_HTTP_CLIENT_PRIVATE_ADDRESS')
  })

  it('refuses the IPv4 spellings a URL normalises to a private address', async () => {
    for (const url of ['http://0x7f.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/']) {
      expect((await failure(new HttpClient().get(url))).reason, url).toBe('privateAddress')
    }
  })

  it('refuses at connect time a NAME that resolves to a private address', async () => {
    routes.set('/ok', (_req, res) => res.end('reached'))
    const before = seen.length
    const error = await failure(new HttpClient().get(`http://localhost:${port}/ok`))
    expect(error.reason).toBe('privateAddress')
    expect(error.message).toMatch(/not a public address/)
    expect(seen.length).toBe(before)
  })

  it('reaches a host listed in allowHosts', async () => {
    routes.set('/ok', (_req, res) => res.end('reached'))
    const response = await localClient().get(`http://localhost:${port}/ok`)
    expect(response.status).toBe(200)
    expect(response.text()).toBe('reached')
  })

  it('matches allowHosts on host AND port', async () => {
    const client = new HttpClient({ allowHosts: ['localhost:1'] })
    expect((await failure(client.get(`http://localhost:${port}/ok`))).reason).toBe('privateAddress')
  })

  it('refuses a scheme other than http and https, and credentials in the URL', async () => {
    expect((await failure(new HttpClient().get('file:///etc/passwd'))).reason).toBe('invalidUrl')
    expect((await failure(new HttpClient().get('gopher://example.com/'))).reason).toBe('invalidUrl')
    expect((await failure(new HttpClient().get('https://u:p@example.com/'))).reason).toBe(
      'invalidUrl',
    )
    expect((await failure(new HttpClient().get('not a url'))).reason).toBe('invalidUrl')
  })

  it('is a ReamError, matched by code', async () => {
    const error = await failure(new HttpClient().get('http://10.0.0.5/'))
    expect(isReamError(error, 'E_HTTP_CLIENT_PRIVATE_ADDRESS')).toBe(true)
  })

  it('keeps the query string, which may carry a token, out of the error', async () => {
    const error = await failure(new HttpClient().get('http://10.0.0.5/api?token=secret'))
    expect(error.url).toBe('http://10.0.0.5/api')
    expect(JSON.stringify(error.context)).not.toContain('secret')
  })
})

describe('HttpClient > requests and responses', () => {
  it('sends the method, headers, JSON body and the app user agent', async () => {
    routes.set('/echo', (req, res, body) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ method: req.method, body, ua: req.headers['user-agent'] }))
    })
    const client = localClient({ userAgent: 'coconyx/1.0', headers: { 'X-Team': 'cms' } })
    const response = await client.post(`http://127.0.0.1:${port}/echo`, { json: { a: 1 } })
    expect(response.ok).toBe(true)
    expect(response.header('Content-Type')).toBe('application/json')
    expect(response.json()).toEqual({ method: 'POST', body: '{"a":1}', ua: 'coconyx/1.0' })
    const last = seen.at(-1)
    expect(last?.headers['x-team']).toBe('cms')
    expect(last?.headers['content-type']).toBe('application/json')
  })

  it('answers non-2xx statuses rather than throwing', async () => {
    const response = await localClient().get(`http://127.0.0.1:${port}/nowhere`)
    expect(response.status).toBe(404)
    expect(response.ok).toBe(false)
  })

  it('reports an unreachable host', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const address = closed.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const client = new HttpClient({ allowHosts: [`127.0.0.1:${address.port}`] })
    const error = await failure(client.get(`http://127.0.0.1:${address.port}/`))
    expect(error.reason).toBe('unreachable')
  })
})

describe('HttpClient > bounds', () => {
  it('times out a server that never answers', async () => {
    routes.set('/hang', () => {})
    const started = Date.now()
    const error = await failure(localClient({ timeout: 100 }).get(`http://127.0.0.1:${port}/hang`))
    expect(error.reason).toBe('timedOut')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('times out a body that trickles forever', async () => {
    routes.set('/trickle', (_req, res) => {
      res.writeHead(200)
      res.write('a')
    })
    const error = await failure(
      localClient({ timeout: 150 }).get(`http://127.0.0.1:${port}/trickle`),
    )
    expect(error.reason).toBe('timedOut')
  })

  it('refuses a body larger than maxResponseBytes, declared up front', async () => {
    routes.set('/big', (_req, res) => {
      res.setHeader('content-length', '5000')
      res.end('x'.repeat(5000))
    })
    const error = await failure(
      localClient({ maxResponseBytes: 1000 }).get(`http://127.0.0.1:${port}/big`),
    )
    expect(error.reason).toBe('tooLarge')
  })

  it('refuses a chunked body once it grows past maxResponseBytes', async () => {
    routes.set('/stream', (_req, res) => {
      res.writeHead(200)
      for (let i = 0; i < 50; i++) res.write('y'.repeat(100))
      res.end()
    })
    const error = await failure(
      localClient().get(`http://127.0.0.1:${port}/stream`, { maxResponseBytes: 1000 }),
    )
    expect(error.reason).toBe('tooLarge')
  })

  it('lets the caller abort', async () => {
    routes.set('/hang', () => {})
    const controller = new AbortController()
    const pending = localClient().get(`http://127.0.0.1:${port}/hang`, {
      signal: controller.signal,
    })
    controller.abort(new Error('user gave up'))
    await expect(pending).rejects.toThrow('user gave up')
  })
})

describe('HttpClient > redirects', () => {
  it('follows a redirect on the same host', async () => {
    routes.set('/old', (_req, res) => res.writeHead(301, { location: '/new' }).end())
    routes.set('/new', (_req, res) => res.end('moved'))
    const response = await localClient().get(`http://127.0.0.1:${port}/old`)
    expect(response.text()).toBe('moved')
    expect(response.url).toBe(`http://127.0.0.1:${port}/new`)
  })

  it('refuses a redirect to another host by default', async () => {
    routes.set('/away', (_req, res) =>
      res.writeHead(302, { location: `http://localhost:${port}/new` }).end(),
    )
    const error = await failure(localClient().get(`http://127.0.0.1:${port}/away`))
    expect(error.reason).toBe('redirect')
  })

  it('applies the address rule to every hop of an allowed cross-host redirect', async () => {
    routes.set('/to-metadata', (_req, res) =>
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    )
    const client = localClient({ crossHostRedirects: true })
    const error = await failure(client.get(`http://127.0.0.1:${port}/to-metadata`))
    expect(error.reason).toBe('privateAddress')
  })

  it('drops credentials on an allowed cross-host redirect', async () => {
    routes.set('/hop', (_req, res) =>
      res.writeHead(307, { location: `http://localhost:${port}/landing` }).end(),
    )
    routes.set('/landing', (_req, res) => res.end('ok'))
    await localClient({ crossHostRedirects: true }).get(`http://127.0.0.1:${port}/hop`, {
      headers: { Authorization: 'Bearer secret' },
    })
    const [hop, landing] = seen.slice(-2)
    expect(hop?.headers.authorization).toBe('Bearer secret')
    expect(landing?.headers.authorization).toBeUndefined()
  })

  it('stops after maxRedirects', async () => {
    routes.set('/loop', (_req, res) => res.writeHead(302, { location: '/loop' }).end())
    const error = await failure(
      localClient({ maxRedirects: 2 }).get(`http://127.0.0.1:${port}/loop`),
    )
    expect(error.reason).toBe('redirect')
  })

  it('hands back the 3xx itself when maxRedirects is 0', async () => {
    routes.set('/old', (_req, res) => res.writeHead(301, { location: '/new' }).end())
    const response = await localClient({ maxRedirects: 0 }).get(`http://127.0.0.1:${port}/old`)
    expect(response.status).toBe(301)
  })

  it('turns a POST into a GET without body on 303', async () => {
    routes.set('/submit', (_req, res) => res.writeHead(303, { location: '/done' }).end())
    routes.set('/done', (req, res, body) => res.end(`${req.method}:${body}`))
    const response = await localClient().post(`http://127.0.0.1:${port}/submit`, { body: 'x=1' })
    expect(response.text()).toBe('GET:')
  })

  it('keeps method and body on 307', async () => {
    routes.set('/keep', (_req, res) => res.writeHead(307, { location: '/done' }).end())
    routes.set('/done', (req, res, body) => res.end(`${req.method}:${body}`))
    const response = await localClient().post(`http://127.0.0.1:${port}/keep`, { body: 'x=1' })
    expect(response.text()).toBe('POST:x=1')
  })
})

describe('fakeHttp', () => {
  it('answers registered routes and records the requests', async () => {
    const http = fakeHttp()
    http.on('GET', 'https://cms.example.com/api/posts', { json: [{ id: 1 }] })
    const response = await http.get('https://cms.example.com/api/posts?page=2')
    expect(response.json()).toEqual([{ id: 1 }])
    expect(response.header('content-type')).toBe('application/json')
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]?.url).toBe('https://cms.example.com/api/posts?page=2')
  })

  it('lets the latest registration win', async () => {
    const http = fakeHttp()
    http.onAny(/example\.com/, { body: 'first' })
    http.onAny(/example\.com/, { body: 'second' })
    expect((await http.post('https://example.com/x')).text()).toBe('second')
  })

  it('records the body sent', async () => {
    const http = fakeHttp()
    http.on(
      'POST',
      (request) => request.url.endsWith('/hooks'),
      (request) => ({
        status: 201,
        body: request.body?.toString('utf8') ?? '',
      }),
    )
    const response = await http.post('https://example.com/hooks', { json: { event: 'paid' } })
    expect(response.status).toBe(201)
    expect(response.text()).toBe('{"event":"paid"}')
  })

  it('fails unmatched requests as unreachable', async () => {
    const error = await failure(fakeHttp().get('https://example.com/nothing'))
    expect(error.reason).toBe('unreachable')
  })

  it('still refuses a private address literal', async () => {
    const http = fakeHttp()
    http.onAny(() => true, { body: 'should not be reached' })
    const error = await failure(http.get('http://169.254.169.254/latest/meta-data/'))
    expect(error.reason).toBe('privateAddress')
    expect(http.requests).toHaveLength(0)
  })

  it('still applies the redirect policy and the size limit', async () => {
    const http = fakeHttp({ maxResponseBytes: 10 })
    http.on('GET', 'https://a.example.com/', {
      status: 302,
      headers: { Location: 'https://b.example.com/' },
    })
    http.on('GET', 'https://a.example.com/big', { body: 'x'.repeat(11) })
    http.on('GET', 'https://a.example.com/down', {
      status: 301,
      headers: { location: 'http://a.example.com/' },
    })
    expect((await failure(http.get('https://a.example.com/'))).reason).toBe('redirect')
    expect((await failure(http.get('https://a.example.com/big'))).reason).toBe('tooLarge')
    expect((await failure(http.get('https://a.example.com/down'))).reason).toBe('redirect')
  })

  it('resets', async () => {
    const http = fakeHttp()
    http.onAny(() => true, { body: 'x' })
    await http.get('https://example.com/')
    http.reset()
    expect(http.requests).toHaveLength(0)
    expect((await failure(http.get('https://example.com/'))).reason).toBe('unreachable')
  })
})

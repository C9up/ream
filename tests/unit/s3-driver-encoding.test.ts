/**
 * S3Driver key-encoding regression. Object keys with spaces, `#`,
 * `?`, `%` or non-ASCII bytes must be percent-encoded IDENTICALLY in
 * the request URL and the SigV4 canonical path — otherwise the
 * requested path drifts from the signed path (403 SignatureDoesNotMatch)
 * or `?`/`#` truncates the URL entirely, making valid object names
 * unreadable/unwritable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { S3Driver } from '../../src/storage/S3Driver.js'

const CONFIG = {
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'secret_test',
}

let fetchCalls: Array<{ url: string; init: RequestInit }>

beforeEach(() => {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      fetchCalls.push({ url: String(url), init })
      return Promise.resolve(new Response('', { status: 200, headers: { 'content-length': '0' } }))
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('S3Driver > key encoding', () => {
  it('percent-encodes spaces and # in the request URL (put)', async () => {
    const driver = new S3Driver(CONFIG)
    await driver.put('reports/Q1 final#2.pdf', Buffer.from('x'))
    expect(fetchCalls).toHaveLength(1)
    const url = fetchCalls[0].url
    expect(url).toContain('/my-bucket/reports/Q1%20final%232.pdf')
    // The raw chars must NOT appear unencoded.
    expect(url).not.toContain('Q1 final#2')
  })

  it('preserves / as the key hierarchy delimiter (not encoded to %2F)', async () => {
    const driver = new S3Driver(CONFIG)
    await driver.get('a/b/c/file.txt')
    expect(fetchCalls[0].url).toContain('/my-bucket/a/b/c/file.txt')
    expect(fetchCalls[0].url).not.toContain('%2F')
  })

  it('encodes ? so it cannot truncate the path into a query string', async () => {
    const driver = new S3Driver(CONFIG)
    await driver.get('weird?name.txt')
    const url = fetchCalls[0].url
    expect(url).toContain('weird%3Fname.txt')
    // No bare `?` — it would otherwise start a query string and drop
    // everything after it from the path the server resolves.
    expect(new URL(url).search).toBe('')
  })

  it('encodes non-ASCII bytes (UTF-8 object names)', async () => {
    const driver = new S3Driver(CONFIG)
    await driver.delete('factures/reçu-éte.pdf')
    const url = fetchCalls[0].url
    expect(url).toContain('factures/')
    // `ç` and `é` must be percent-encoded UTF-8.
    expect(url).toContain('re%C3%A7u-%C3%A9te.pdf')
  })

  it('signs the SAME encoded path it requests (Authorization present + URL encoded)', async () => {
    const driver = new S3Driver(CONFIG)
    await driver.put('my key/with space.txt', Buffer.from('data'))
    const { url, init } = fetchCalls[0]
    const headers = init.headers as Record<string, string>
    // A signature was produced.
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /)
    // The URL the browser hits is the encoded form. Because signRequest
    // receives the SAME encoded key, the canonical path it signed
    // matches this URL path — the request can't drift from the signature.
    expect(url).toContain('/my-bucket/my%20key/with%20space.txt')
  })

  it('url() returns the encoded public path', () => {
    const driver = new S3Driver({ ...CONFIG, publicUrl: 'https://cdn.example.com' })
    expect(driver.url('img/hero shot.png')).toBe('https://cdn.example.com/img/hero%20shot.png')
  })

  it('round-trips a plain ASCII key unchanged (no over-encoding regression)', async () => {
    const driver = new S3Driver(CONFIG)
    await driver.get('simple/path/file.json')
    expect(fetchCalls[0].url).toBe(
      'https://s3.us-east-1.amazonaws.com/my-bucket/simple/path/file.json',
    )
  })
})

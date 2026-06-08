import { describe, expect, it } from 'vitest'
import { parseHttpResponse } from '../../src/testing/TestClient.js'

function rawResponse(headers: string, body: string): string {
  return `${headers}\r\n\r\n${body}`
}

describe('TestClient > parseHttpResponse', () => {
  it('returns the raw body verbatim for identity (non-chunked) responses', () => {
    const raw = rawResponse(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5',
      'hello',
    )
    const res = parseHttpResponse(raw)
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello')
    expect(res.headers['content-type']).toBe('text/plain')
  })

  it('decodes a Transfer-Encoding: chunked body and strips the header', () => {
    const chunked = '4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n'
    const raw = rawResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked', chunked)
    const res = parseHttpResponse(raw)
    expect(res.status).toBe(200)
    expect(res.body).toBe('Wikipedia')
    expect(res.headers['transfer-encoding']).toBeUndefined()
  })

  it('handles single-chunk responses', () => {
    const raw = rawResponse(
      'HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked',
      'b\r\nhello world\r\n0\r\n\r\n',
    )
    expect(parseHttpResponse(raw).body).toBe('hello world')
  })

  it('ignores chunk extensions (RFC 7230 §4.1.1)', () => {
    const raw = rawResponse(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked',
      '5;name=foo\r\nhello\r\n0\r\n\r\n',
    )
    expect(parseHttpResponse(raw).body).toBe('hello')
  })

  it('matches `chunked` case-insensitively in Transfer-Encoding', () => {
    const raw = rawResponse(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked',
      '5\r\nhello\r\n0\r\n\r\n',
    )
    expect(parseHttpResponse(raw).body).toBe('hello')
  })

  it('still decodes when chunked is one of several Transfer-Encoding values', () => {
    const raw = rawResponse(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked',
      '5\r\nhello\r\n0\r\n\r\n',
    )
    expect(parseHttpResponse(raw).body).toBe('hello')
  })

  it('returns an empty body for the terminator-only chunked stream', () => {
    const raw = rawResponse('HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked', '0\r\n\r\n')
    const res = parseHttpResponse(raw)
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
  })

  it('falls back to a partial body if a chunk is truncated mid-payload', () => {
    const raw = rawResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked', '5\r\nhel')
    expect(parseHttpResponse(raw).body).toBe('hel')
  })

  it('decodes a chunked body containing multi-byte UTF-8 without truncation (é, emoji)', () => {
    // 'café' is 5 bytes in UTF-8 (c=0x63, a=0x61, f=0x66, é=0xC3 0xA9). The
    // chunk size MUST be the byte count (5), not the character count (4).
    // Pre-fix: parseHttpResponse converted the whole response to a JS string
    // and sliced by code units, truncating 'café' to 'cafÃ' (read 5 code
    // units of a 4-character string).
    const headerBuf = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n', 'ascii')
    const payload = Buffer.from('café 🚀', 'utf8')
    const sizeHex = payload.byteLength.toString(16)
    const chunkBuf = Buffer.concat([
      Buffer.from(`${sizeHex}\r\n`, 'ascii'),
      payload,
      Buffer.from('\r\n0\r\n\r\n', 'ascii'),
    ])
    const res = parseHttpResponse(Buffer.concat([headerBuf, chunkBuf]))
    expect(res.body).toBe('café 🚀')
  })

  it('preserves byte sequences across multiple chunks of multi-byte UTF-8', () => {
    // Splits 'café' across two chunks at a multi-byte boundary: 'caf' (3 B)
    // + 'é' (2 B). Buffer-native slicing keeps each chunk byte-exact;
    // string-based slicing would lose the multi-byte continuation halfway.
    const headerBuf = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n', 'ascii')
    const c1 = Buffer.from('caf', 'utf8') // 3 bytes
    const c2 = Buffer.from('é', 'utf8') // 2 bytes
    const chunkBuf = Buffer.concat([
      Buffer.from(`${c1.byteLength.toString(16)}\r\n`, 'ascii'),
      c1,
      Buffer.from('\r\n', 'ascii'),
      Buffer.from(`${c2.byteLength.toString(16)}\r\n`, 'ascii'),
      c2,
      Buffer.from('\r\n0\r\n\r\n', 'ascii'),
    ])
    expect(parseHttpResponse(Buffer.concat([headerBuf, chunkBuf])).body).toBe('café')
  })
})

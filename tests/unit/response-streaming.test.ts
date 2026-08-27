/**
 * `response.stream()` / `download()` push chunks to the socket instead of
 * reading the whole body into memory first.
 *
 * The old behaviour drained the readable into an array of Buffers and
 * `Buffer.concat`'d it, so a 4GB file meant 4GB of RAM (plus a third again for
 * the base64 encoding) before a single byte left the process. These tests pin
 * the three things that make the new path trustworthy: the bytes arrive
 * intact, the source stops being read when the client leaves, and a host that
 * cannot stream still works.
 */
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Response } from '../../src/http/Response.js'
import type { StreamBackend } from '../../src/http/SseStream.js'

/** A backend that records what was pushed, the way the Rust registry would. */
class RecordingBackend implements StreamBackend {
  readonly chunks: Buffer[] = []
  registered: string[] = []
  closed: string[] = []
  /** Set to make writeStreamBytes report the client as gone from that call on. */
  disconnectAfter = Number.POSITIVE_INFINITY

  async registerStream(streamId: string): Promise<boolean> {
    this.registered.push(streamId)
    return true
  }

  async writeStream(): Promise<boolean> {
    return true
  }

  async writeStreamBytes(_streamId: string, chunk: Uint8Array): Promise<boolean> {
    if (this.chunks.length >= this.disconnectAfter) return false
    this.chunks.push(Buffer.from(chunk))
    return true
  }

  async closeStream(streamId: string): Promise<boolean> {
    this.closed.push(streamId)
    return true
  }

  onStreamDisconnect(): void {}

  body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ream-streaming-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('response.stream — chunks reach the socket', () => {
  it('pushes each chunk instead of buffering the whole body', async () => {
    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)

    await res.stream(Readable.from([Buffer.from('one'), Buffer.from('two'), Buffer.from('three')]))
    await res.streamed()
    await res.streamed()

    // Three pushes, not one concatenated body.
    expect(backend.chunks.map((c) => c.toString())).toEqual(['one', 'two', 'three'])
    // The buffered body stays empty: the bytes went through the registry.
    expect(res.getBody()).toBe('')
    expect(res.getStreamId()).toBeDefined()
  })

  it('carries bytes that are not valid UTF-8, unchanged', async () => {
    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)

    // A PNG signature plus bytes no UTF-8 decoder would survive.
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80])
    await res.stream(Readable.from([payload]))
    await res.streamed()

    expect(backend.body().equals(payload)).toBe(true)
  })

  it('closes the stream when the source ends', async () => {
    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)

    await res.stream(Readable.from([Buffer.from('x')]))
    await res.streamed()

    expect(backend.closed).toEqual(backend.registered)
  })

  it('stops reading the source once the client is gone', async () => {
    const backend = new RecordingBackend()
    backend.disconnectAfter = 2
    const res = new Response()
    res.setStreamBackend(backend)

    let produced = 0
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 100; i++) {
          produced += 1
          yield Buffer.from([i])
        }
      })(),
    )

    await res.stream(source)
    await res.streamed()

    // Pumping a whole file into a closed socket is the waste this avoids.
    expect(backend.chunks).toHaveLength(2)
    expect(produced).toBeLessThan(10)
    expect(backend.closed).toHaveLength(1)
  })

  it('falls back to buffering when the host cannot stream bytes', async () => {
    // A unit test, a mock server: no binary backend, so the old path applies
    // and nothing breaks.
    const res = new Response()
    await res.stream(Readable.from([Buffer.from('ab'), Buffer.from('cd')]))
    await res.streamed()

    expect(res.getStreamId()).toBeUndefined()
    expect(Buffer.from(res.getBody(), 'base64').toString()).toBe('abcd')
  })

  it('still reports a read failure through the buffered path', async () => {
    const res = new Response()
    const broken = new Readable({
      read() {
        this.destroy(new Error('disk died'))
      },
    })

    await res.stream(broken, () => ['Cannot read', 503])
    await res.streamed()

    expect(res.getStatus()).toBe(503)
    expect(res.getBody()).toBe('Cannot read')
  })
})

describe('response.download — streams from disk', () => {
  it('sends the file in chunks, with its length and type', async () => {
    const file = join(dir, 'report.txt')
    writeFileSync(file, 'x'.repeat(200_000))

    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)
    res.download(file)
    await res.settle()
    await res.streamed()

    expect(backend.chunks.length).toBeGreaterThan(1)
    expect(backend.body()).toHaveLength(200_000)
    expect(res.getHeader('content-length')).toBe('200000')
    expect(res.getHeader('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('answers 404 before any header goes out, when the file is missing', async () => {
    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)
    res.download(join(dir, 'nope.bin'))
    await res.settle()

    // Once a stream starts there is no status left to change, so the stat has
    // to come first.
    expect(res.getStatus()).toBe(404)
    expect(backend.registered).toHaveLength(0)
  })

  it('buffers when an ETag is asked for, since a hash needs the whole file', async () => {
    const file = join(dir, 'etagged.txt')
    writeFileSync(file, 'hello')

    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)
    res.download(file, true)
    await res.settle()

    expect(res.getHeader('etag')).toBeDefined()
    expect(backend.chunks).toHaveLength(0)
    expect(Buffer.from(res.getBody(), 'base64').toString()).toBe('hello')
  })

  it('a streamed download is not held in memory, so the ceiling does not apply', async () => {
    const file = join(dir, 'big.bin')
    writeFileSync(file, Buffer.alloc(300_000))

    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)
    res.setMaxBodyBytes(1024) // far below the file
    res.download(file)

    // The ceiling guards the BUFFERED path; a streamed body never assembles.
    await expect(res.settle()).resolves.toBeUndefined()
    await res.streamed()
    expect(backend.body()).toHaveLength(300_000)
  })

  it('streams a file read straight off the disk', async () => {
    const file = join(dir, 'raw.bin')
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f])
    writeFileSync(file, payload)

    const backend = new RecordingBackend()
    const res = new Response()
    res.setStreamBackend(backend)
    await res.stream(createReadStream(file))
    await res.streamed()

    expect(backend.body().equals(payload)).toBe(true)
  })
})

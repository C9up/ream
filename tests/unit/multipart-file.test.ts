import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MultipartFile } from '../../src/bodyparser/MultipartFile.js'

async function drainStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
}

describe('MultipartFile.detectType() — magic-byte content detection', () => {
  // Minimal valid PNG: 8-byte signature + IHDR chunk.
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
  ])

  it('detects the real type of a binary renamed to a benign extension', async () => {
    const file = new MultipartFile({
      fieldName: 'doc',
      clientName: 'evil.txt', // lies — content is a PNG
      type: 'text/plain', // attacker-controlled header — also a lie
      content: PNG,
    })
    await file.detectType()

    expect(file.detectedType).toBe('image/png')
    expect(file.extname).toBe('png') // detected, not the client 'txt'
    expect(file.validate({ extnames: ['png'] })).toBe(true)

    const spoof = new MultipartFile({
      fieldName: 'doc',
      clientName: 'evil.txt',
      type: 'text/plain',
      content: PNG,
    })
    await spoof.detectType()
    expect(spoof.validate({ extnames: ['txt'] })).toBe(false) // real type is png, not txt
  })

  it('falls back to the client extension for content file-type cannot fingerprint (text)', async () => {
    const file = new MultipartFile({
      fieldName: 'note',
      clientName: 'note.txt',
      type: 'text/plain',
      content: Buffer.from('just some plain text', 'utf8'),
    })
    await file.detectType()

    expect(file.detectedType).toBeUndefined()
    expect(file.extname).toBe('txt') // client fallback
  })
})

describe('MultipartFile.stream()', () => {
  it('returns a readable that re-emits the buffer bytes', async () => {
    const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])
    const file = new MultipartFile({
      fieldName: 'avatar',
      clientName: 'pic.png',
      type: 'image/png',
      content,
    })
    const drained = await drainStream(file.stream())
    expect(drained.equals(content)).toBe(true)
  })

  it('each stream() call returns a fresh readable starting at byte 0', async () => {
    const content = Buffer.from('hello world', 'utf8')
    const file = new MultipartFile({
      fieldName: 'doc',
      clientName: 'doc.txt',
      type: 'text/plain',
      content,
    })
    const first = await drainStream(file.stream())
    const second = await drainStream(file.stream())
    expect(first.toString('utf8')).toBe('hello world')
    expect(second.toString('utf8')).toBe('hello world')
  })
})

describe('MultipartFile.moveToDisk()', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ream-multipart-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function makeFile(clientName: string): MultipartFile {
    return new MultipartFile({
      fieldName: 'avatar',
      clientName,
      type: 'image/png',
      content: Buffer.from('payload', 'utf8'),
    })
  }

  it('rejects a name containing path traversal (..)', async () => {
    const file = makeFile('attack.png')
    await expect(file.moveToDisk(workDir, '../../etc/passwd')).rejects.toThrow(
      /must be a plain filename/,
    )
  })

  it('rejects a name containing path separators', async () => {
    const file = makeFile('attack.png')
    await expect(file.moveToDisk(workDir, 'sub/dir/evil.txt')).rejects.toThrow(
      /must be a plain filename/,
    )
    await expect(file.moveToDisk(workDir, 'sub\\dir\\evil.txt')).rejects.toThrow(
      /must be a plain filename/,
    )
  })

  it('writes a plain filename inside the target directory', async () => {
    const file = makeFile('upload.png')
    const written = await file.moveToDisk(workDir, 'safe.png')
    expect(written).toBe(join(workDir, 'safe.png'))
    expect(readFileSync(written, 'utf8')).toBe('payload')
  })

  it('rejects a name containing a NUL byte', async () => {
    // Node's writeFileSync rejects NUL at the syscall layer, but
    // defense-in-depth: the guard must reject before path.join.
    const file = makeFile('attack.png')
    await expect(file.moveToDisk(workDir, 'safe\0.png')).rejects.toThrow(/must be a plain filename/)
  })

  it('rejects a hostile clientName-derived extname when no name is supplied', async () => {
    // clientName "../etc/passwd" → split('.') → last segment "/etc/passwd"
    // → extname "/etc/passwd". Without the second guard the default
    // fileName would be "<hex>./etc/passwd" — a path with separators.
    const file = makeFile('../etc/passwd')
    await expect(file.moveToDisk(workDir)).rejects.toThrow(/derived filename .* unsafe/)
  })

  it('writes with a generated random name when none is supplied', async () => {
    const written = await makeFile('upload.png').moveToDisk(workDir)
    expect(written.startsWith(join(workDir, ''))).toBe(true)
    expect(written.endsWith('.png')).toBe(true)
    expect(readFileSync(written, 'utf8')).toBe('payload')
  })
})

describe('MultipartFile metadata + validate()', () => {
  function file(clientName: string, content: string): MultipartFile {
    return new MultipartFile({
      fieldName: 'f',
      clientName,
      type: 'application/octet-stream',
      content: Buffer.from(content, 'utf8'),
    })
  }

  it('derives a lowercased extname and byte size; empty when no dot', () => {
    const f = file('Photo.PNG', 'abc')
    expect(f.extname).toBe('png')
    expect(f.size).toBe(3)
    expect(file('noext', 'x').extname).toBe('')
  })

  it('flags an oversized file and parses size units (kb/mb/gb)', () => {
    const big = file('a.bin', 'x'.repeat(2000))
    expect(big.validate({ size: '1kb' })).toBe(false)
    expect(big.errors[0]).toMatch(/exceeds limit/)
    // mb / gb thresholds are far larger → same file passes.
    expect(file('b.bin', 'x'.repeat(2000)).validate({ size: '1mb' })).toBe(true)
    expect(file('c.bin', 'x'.repeat(2000)).validate({ size: '1gb' })).toBe(true)
  })

  it('rejects a disallowed extension and accepts an allowed one', () => {
    expect(file('a.exe', 'x').validate({ extnames: ['png', 'jpg'] })).toBe(false)
    expect(file('a.png', 'x').validate({ extnames: ['png', 'jpg'] })).toBe(true)
  })

  it('reports isValid via the errors list', () => {
    const f = file('a.exe', 'x')
    expect(f.isValid).toBe(true)
    f.validate({ extnames: ['png'] })
    expect(f.isValid).toBe(false)
  })
})

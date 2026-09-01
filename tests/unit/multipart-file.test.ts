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

describe('MultipartFile > AdonisJS surface', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ream-move-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function upload(clientName: string, type = 'text/plain', content = 'BYTES'): MultipartFile {
    return new MultipartFile({
      fieldName: 'f',
      clientName,
      type,
      content: Buffer.from(content, 'utf8'),
    })
  }

  it('splits the mime into type and subtype, as upstream does', () => {
    const f = upload('a.png', 'image/png')
    expect(f.type).toBe('image')
    expect(f.subtype).toBe('png')
    expect(f.mime).toBe('image/png')
    // The whole header is still reachable, it just is not `type` any more.
    expect(f.headers['content-type']).toBe('image/png')
  })

  it('reports what the BYTES say, not what the header claims', async () => {
    // A real incident: an app filtered uploads with
    // `ALLOWED_MIME.has(file.type)`. If `type` came from the header, a .exe
    // announced as image/png would pass. Upstream derives it from the magic
    // bytes and falls back to the header only when they cannot be read.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)])
    const f = new MultipartFile({
      fieldName: 'f',
      clientName: 'photo.png',
      type: 'image/png',
      content: pdf,
    })

    await f.detectType()

    expect(f.mime).toBe('application/pdf')
    expect(f.type).toBe('application')
    expect(f.subtype).toBe('pdf')
    // The lie is still on record, it just is not what validation reads.
    expect(f.headers['content-type']).toBe('image/png')
  })

  it('falls back to the header for content with no magic signature', async () => {
    // Text formats have no signature; upstream keeps the header there too.
    const f = upload('notes.txt', 'text/plain', 'just words')
    await f.detectType()

    expect(f.mime).toBe('text/plain')
    expect(f.type).toBe('text')
  })

  it('drops the parameters off a content-type before splitting', () => {
    const f = upload('a.txt', 'text/plain; charset=utf-8')
    expect(f.type).toBe('text')
    expect(f.subtype).toBe('plain')
  })

  it('survives a content-type with no slash rather than inventing a subtype', () => {
    const f = upload('a.bin', 'garbage')

    // Upstream's contract: the raw segment comes back, whatever it is.
    expect(f.type).toBe('garbage')
    expect(f.subtype).toBeUndefined()
    expect(f.mime).toBe('garbage')
    // The narrowed member is where an unregistered type reads as absent.
    expect(f.registeredType).toBeUndefined()
  })

  it('keeps an unregistered tree on type, and off registeredType', () => {
    const f = upload('a.bin', 'x-foo/bar')

    expect(f.type).toBe('x-foo')
    expect(f.mime).toBe('x-foo/bar')
    expect(f.registeredType).toBeUndefined()
  })

  it('agrees on a registered type', () => {
    const f = upload('a.png', 'image/png')

    expect(f.type).toBe('image')
    expect(f.registeredType).toBe('image')
  })

  it('move() writes the file and records where it went', async () => {
    const f = upload('note.txt')
    expect(f.state).toBe('consumed')

    await f.move(dir, { name: 'saved.txt' })

    expect(readFileSync(join(dir, 'saved.txt'), 'utf8')).toBe('BYTES')
    expect(f.fileName).toBe('saved.txt')
    expect(f.filePath).toBe(join(dir, 'saved.txt'))
    expect(f.state).toBe('moved')
    expect(f.isMoved).toBe(true)
  })

  it('move() creates the directory, and names the file when the caller does not', async () => {
    const f = upload('note.txt')
    const nested = join(dir, 'deep', 'deeper')

    await f.move(nested)

    expect(f.fileName).toMatch(/^[0-9a-f]{32}\.txt$/)
    expect(readFileSync(f.filePath as string, 'utf8')).toBe('BYTES')
  })

  it('overwrites by default, and refuses when told not to', async () => {
    await upload('a.txt', 'text/plain', 'FIRST').move(dir, { name: 'x.txt' })
    await upload('a.txt', 'text/plain', 'SECOND').move(dir, { name: 'x.txt' })
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('SECOND')

    await expect(
      upload('a.txt', 'text/plain', 'THIRD').move(dir, { name: 'x.txt', overwrite: false }),
    ).rejects.toThrow(/already exists/)
    // The refusal must not have touched the file.
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('SECOND')
  })

  it('refuses a name that would escape the directory', async () => {
    const f = upload('a.txt')
    // The footgun this guards: `await file.move(dir, { name: file.clientName })`
    // with a client name of `../../etc/passwd`.
    await expect(f.move(dir, { name: '../escape.txt' })).rejects.toThrow(/plain filename/)
    await expect(f.move(dir, { name: 'sub/escape.txt' })).rejects.toThrow(/plain filename/)
    expect(f.state).toBe('consumed')
  })

  it('isMultipartFile marks it apart from a plain field', () => {
    expect(upload('a.txt').isMultipartFile).toBe(true)
  })

  it('hasErrors is the inverse of isValid', () => {
    const f = upload('a.txt')
    expect(f.hasErrors).toBe(false)
    f.validate({ extnames: ['png'] })
    expect(f.hasErrors).toBe(true)
    expect(f.isValid).toBe(false)
  })

  it('a bare validate() uses the rules set through the accessors', () => {
    const f = upload('a.txt')
    f.allowedExtensions = ['png', 'jpg']
    expect(f.allowedExtensions).toEqual(['png', 'jpg'])

    expect(f.validate()).toBe(false)
    expect(f.errors[0]).toMatch(/not allowed/)
  })

  it('sizeLimit drives a bare validate() too', () => {
    const f = upload('a.txt', 'text/plain', 'x'.repeat(4096))
    f.sizeLimit = '1kb'
    expect(f.sizeLimit).toBe('1kb')
    expect(f.validate()).toBe(false)
    expect(f.errors[0]).toMatch(/exceeds limit/)
  })

  it('moveToDisk records the move the same way move() does', async () => {
    const f = upload('a.txt')
    const path = await f.moveToDisk(dir, 'legacy.txt')
    expect(f.state).toBe('moved')
    expect(f.filePath).toBe(path)
    expect(f.fileName).toBe('legacy.txt')
  })
})

describe('MultipartFile > move is atomic', () => {
  const makeFile = (content: Buffer): MultipartFile =>
    new MultipartFile({ fieldName: 'doc', clientName: 'up.txt', type: 'text/plain', content })

  it('lets exactly one of two concurrent moves win with overwrite: false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-move-race-'))
    try {
      const first = makeFile(Buffer.from('first'))
      const second = makeFile(Buffer.from('second'))

      // Upstream checks existence and then writes, so both of these see
      // nothing and both succeed — the second silently replacing the first.
      const results = await Promise.allSettled([
        first.move(dir, { name: 'same.txt', overwrite: false }),
        second.move(dir, { name: 'same.txt', overwrite: false }),
      ])

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      const rejected = results.find((r) => r.status === 'rejected')
      expect((rejected as PromiseRejectedResult).reason.message).toContain('already exists at')
      // The winner's bytes are intact — not half of one and half of the other.
      expect(['first', 'second']).toContain(readFileSync(join(dir, 'same.txt'), 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still overwrites by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-move-over-'))
    try {
      await makeFile(Buffer.from('first')).move(dir, { name: 'same.txt' })
      await makeFile(Buffer.from('second')).move(dir, { name: 'same.txt' })
      expect(readFileSync(join(dir, 'same.txt'), 'utf8')).toBe('second')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

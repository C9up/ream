import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MultipartFile } from '../../src/bodyparser/MultipartFile.js'
import { sniffableExtensions, sniffFileType } from '../../src/bodyparser/sniff.js'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'sniff')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

function bytes(...parts: Array<string | readonly number[]>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part),
  )
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Real files, each with the answer `file-type` 22.0.2 gave for it when ream
 * still depended on it — recorded from the library, not written by hand.
 */
const REAL_FILES: Array<[string, string | undefined, string | undefined]> = [
  ['av1.avif', 'avif', 'image/avif'],
  ['be.tif', 'tif', 'image/tiff'],
  ['bom.xml', 'xml', 'application/xml'],
  ['doc.doc', 'cfb', 'application/x-cfb'],
  ['doc.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['doc.odt', 'odt', 'application/vnd.oasis.opendocument.text'],
  ['doc.rtf', 'rtf', 'application/rtf'],
  ['id3.mp3', 'mp3', 'audio/mpeg'],
  ['lastct.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['lzw.tif', 'tif', 'image/tiff'],
  ['plain.svg', undefined, undefined],
  ['raw.mp3', 'mp3', 'audio/mpeg'],
  ['s.7z', '7z', 'application/x-7z-compressed'],
  ['s.aac', 'aac', 'audio/aac'],
  ['s.aif', 'aif', 'audio/aiff'],
  ['s.apng', 'apng', 'image/apng'],
  ['s.avi', 'avi', 'video/vnd.avi'],
  ['s.bmp', 'bmp', 'image/bmp'],
  ['s.csv', undefined, undefined],
  ['s.epub', 'epub', 'application/epub+zip'],
  ['s.exe', 'exe', 'application/x-msdownload'],
  ['s.flac', 'flac', 'audio/flac'],
  ['s.gif', 'gif', 'image/gif'],
  ['s.html', undefined, undefined],
  ['s.ico', 'ico', 'image/x-icon'],
  ['s.jar', 'jar', 'application/java-archive'],
  ['s.jp2', 'jp2', 'image/jp2'],
  ['s.jpg', 'jpg', 'image/jpeg'],
  ['s.json', undefined, undefined],
  ['s.jxl', 'jxl', 'image/jxl'],
  ['s.m4a', 'm4a', 'audio/x-m4a'],
  ['s.macho', 'macho', 'application/x-mach-binary'],
  ['s.mkv', 'mkv', 'video/matroska'],
  ['s.mov', 'mov', 'video/quicktime'],
  ['s.mp4', 'mp4', 'video/mp4'],
  ['s.odp', 'odp', 'application/vnd.oasis.opendocument.presentation'],
  ['s.ogg', 'ogg', 'audio/ogg'],
  ['s.ogv', 'ogv', 'video/ogg'],
  ['s.opus', 'opus', 'audio/ogg; codecs=opus'],
  ['s.pdf', 'pdf', 'application/pdf'],
  ['s.png', 'png', 'image/png'],
  ['s.pptm', 'pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.12'],
  ['s.pptx', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['s.psd', 'psd', 'image/vnd.adobe.photoshop'],
  ['s.tar', 'tar', 'application/x-tar'],
  ['s.tar.gz', 'tar.gz', 'application/gzip'],
  ['s.tif', 'tif', 'image/tiff'],
  ['s.txt', undefined, undefined],
  ['s.txt.bz2', 'bz2', 'application/x-bzip2'],
  ['s.txt.gz', 'gz', 'application/gzip'],
  ['s.txt.xz', 'xz', 'application/x-xz'],
  ['s.txt.zst', 'zst', 'application/zstd'],
  ['s.wasm', 'wasm', 'application/wasm'],
  ['s.wav', 'wav', 'audio/wav'],
  ['s.webm', 'webm', 'video/webm'],
  ['s.webp', 'webp', 'image/webp'],
  ['s.zip', 'zip', 'application/zip'],
  ['sheet.ods', 'ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['sheet.xls', 'cfb', 'application/x-cfb'],
  ['sheet.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [
    'streamed.docx',
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['utf16.xml', 'xml', 'application/xml'],
  ['xmlhead.svg', 'xml', 'application/xml'],
]

describe('sniffFileType — real files', () => {
  it.each(REAL_FILES)('%s', async (name, ext, mime) => {
    const result = await sniffFileType(fixture(name))
    expect(result).toEqual(ext === undefined ? undefined : { ext, mime })
  })

  it('names only extensions it lists as sniffable', async () => {
    for (const [name] of REAL_FILES) {
      const result = await sniffFileType(fixture(name))
      if (result) expect(sniffableExtensions.has(result.ext)).toBe(true)
    }
  })

  it('lists exactly the extensions the detector can answer', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'bodyparser', 'sniff.ts'),
      'utf8',
    )
    const answered = new Set([...source.matchAll(/found\('([^']+)'/g)].map((match) => match[1]))
    expect([...answered].sort()).toEqual([...sniffableExtensions].sort())
  })
})

describe('sniffFileType — containers told apart', () => {
  const ftyp = (brand: string) => bytes([0, 0, 0, 0x20], 'ftyp', brand, new Array(20).fill(0))

  it.each([
    ['avif', 'avif', 'image/avif'],
    ['heic', 'heic', 'image/heic'],
    ['mif1', 'heic', 'image/heif'],
    ['hevc', 'heic', 'image/heic-sequence'],
    ['qt  ', 'mov', 'video/quicktime'],
    ['M4A ', 'm4a', 'audio/x-m4a'],
    ['3gp4', '3gp', 'video/3gpp'],
    ['3g2a', '3g2', 'video/3gpp2'],
    ['isom', 'mp4', 'video/mp4'],
  ])('ISO media brand %s is %s', async (brand, ext, mime) => {
    expect(await sniffFileType(ftyp(brand))).toEqual({ ext, mime })
  })

  it('tells WebP, AVI and WAV apart inside RIFF', async () => {
    expect((await sniffFileType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')))?.ext).toBe('webp')
    expect((await sniffFileType(bytes('RIFF', [0, 0, 0, 0], 'AVI LIST')))?.ext).toBe('avi')
    expect((await sniffFileType(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')))?.ext).toBe('wav')
    expect(await sniffFileType(bytes('RIFF', [0, 0, 0, 0], 'XXXX0000'))).toBeUndefined()
  })

  it('tells an animated PNG from a still one by the chunk before the image data', async () => {
    expect((await sniffFileType(fixture('s.png')))?.ext).toBe('png')
    expect((await sniffFileType(fixture('s.apng')))?.ext).toBe('apng')
  })

  it('tells a tarball inside gzip from any other gzip stream', async () => {
    expect((await sniffFileType(fixture('s.tar.gz')))?.ext).toBe('tar.gz')
    expect((await sniffFileType(new Uint8Array(gzipSync('not a tarball'))))?.ext).toBe('gz')
  })
})

describe('sniffFileType — unknown and broken input', () => {
  it('answers nothing for an empty or one-byte buffer', async () => {
    expect(await sniffFileType(new Uint8Array(0))).toBeUndefined()
    expect(await sniffFileType(new Uint8Array([0x89]))).toBeUndefined()
  })

  it('answers nothing for text, never a guess', async () => {
    for (const text of ['hello', 'a,b\n1,2\n', '{"a":1}', '<svg/>', '#!/bin/sh\necho hi\n']) {
      expect(await sniffFileType(bytes(text))).toBeUndefined()
    }
  })

  it('answers nothing for a header cut short where the format needs more', async () => {
    // An Ogg page whose codec header never arrives, a PNG chunk with no IHDR
    // first, an EBML header with no DocType.
    expect(await sniffFileType(bytes('OggS', [0, 2, 0, 0]))).toBeUndefined()
    expect(
      await sniffFileType(
        bytes(
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1],
          'tEXt',
          [0, 0, 0, 0, 0],
        ),
      ),
    ).toBeUndefined()
    expect(await sniffFileType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80]))).toBeUndefined()
  })

  it('still names a document cut anywhere past its ZIP signature', async () => {
    // A truncated upload is still told by what it holds: the ZIP walk falls
    // back on the directory names when [Content_Types].xml never arrives.
    const docx = fixture('doc.docx')
    for (let length = 4; length < docx.length; length += 97) {
      const result = await sniffFileType(docx.subarray(0, length))
      expect(['zip', 'docx']).toContain(result?.ext)
    }
  })

  it('stops a ZIP entry that never closes instead of scanning the whole upload', async () => {
    // A local header flagged "size in a data descriptor" whose descriptor never
    // comes, followed by 40 MiB: the scan for it gives up after 1 MiB.
    const header = bytes(
      [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 0x08, 0x00],
      new Array(16).fill(0),
      [0x05, 0x00, 0x00, 0x00],
      'a.txt',
    )
    const upload = new Uint8Array(40 * 1024 * 1024)
    upload.set(header)
    expect(await sniffFileType(upload)).toEqual({ ext: 'zip', mime: 'application/zip' })
  })

  it('does not follow an ID3 tag that claims more than the file holds', async () => {
    const tag = bytes('ID3', [4, 0, 0], [0x7f, 0x7f, 0x7f, 0x7f])
    expect(await sniffFileType(tag)).toEqual({ ext: 'mp3', mime: 'audio/mpeg' })
  })

  it('looks past a UTF-8 BOM', async () => {
    expect((await sniffFileType(bytes([0xef, 0xbb, 0xbf], '%PDF-1.7')))?.ext).toBe('pdf')
  })

  it('does not throw on a ZIP whose entry is not valid deflate data', async () => {
    const name = '[Content_Types].xml'
    const corrupt = bytes(
      [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00],
      new Array(8).fill(0),
      [0x04, 0, 0, 0, 0x10, 0, 0, 0],
      [name.length, 0, 0, 0],
      name,
      [0xff, 0xff, 0xff, 0xff],
    )
    expect(await sniffFileType(corrupt)).toEqual({ ext: 'zip', mime: 'application/zip' })
  })
})

describe('MultipartFile on the in-house sniffer', () => {
  it('refuses a shell script named avatar.png against an image allowlist', async () => {
    const file = new MultipartFile({
      fieldName: 'avatar',
      clientName: 'avatar.png',
      type: 'image/png',
      content: Buffer.from('#!/bin/sh\nrm -rf /\n'),
    })
    await file.detectType()
    expect(file.typeSource).toBe('claimed')
    expect(file.validate({ extnames: ['png', 'jpg'] })).toBe(false)
  })

  it('validates an office document by its content, not its name', async () => {
    const file = new MultipartFile({
      fieldName: 'document',
      clientName: 'report.pdf',
      type: 'application/pdf',
      content: Buffer.from(fixture('doc.docx')),
    })
    await file.detectType()
    expect(file.extname).toBe('docx')
    expect(file.validate({ extnames: ['pdf'] })).toBe(false)
  })
})

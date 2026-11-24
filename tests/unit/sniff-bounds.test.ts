/**
 * Type detection costs a bounded, small amount of event-loop time per request,
 * whatever the uploaded files hold. A body of small crafted ZIPs (runs of
 * empty entries closed by a data descriptor) used to cost about 0.8 ms per
 * kilobyte, in one turn of the event loop. Sizes stay small on purpose.
 */
import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { MultipartFile } from '../../src/bodyparser/MultipartFile.js'
import { SniffBudget, sniffFileType } from '../../src/bodyparser/sniff.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

/** A ZIP made only of empty entries closed by a data descriptor (flag bit 3, compressed size 0). */
function zipOfEmptyEntries(entries: number): Uint8Array {
  const entry = new Uint8Array(30 + 1 + 16)
  const view = new DataView(entry.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(6, 0x0008, true)
  view.setUint16(26, 1, true)
  entry[30] = 0x61
  view.setUint32(31, 0x08074b50, true)
  const out = new Uint8Array(entry.length * entries)
  for (let i = 0; i < entries; i++) out.set(entry, i * entry.length)
  return out
}

/** One stored (uncompressed) ZIP entry with its data. */
function storedEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(30 + name.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint32(18, data.length, true)
  view.setUint32(22, data.length, true)
  view.setUint16(26, name.length, true)
  header.set(Buffer.from(name, 'latin1'), 30)
  return Buffer.concat([header, data])
}

describe('sniffFileType > bounded work', () => {
  it('walks a few hundred crafted entries per file in well under a millisecond each', async () => {
    const zip = zipOfEmptyEntries(200)
    await sniffFileType(zip) // warm-up
    const started = performance.now()
    for (let i = 0; i < 100; i++)
      expect(await sniffFileType(zip)).toEqual({ ext: 'zip', mime: 'application/zip' })
    // Before: a fresh zero-filled 256 KiB buffer per entry, about 1.4 s here.
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('shares one entry budget between the files of a request; a file past it gets no answer', async () => {
    const budget = new SniffBudget({ zipEntries: 300 })
    const zip = zipOfEmptyEntries(200)
    expect(await sniffFileType(zip, budget)).toEqual({ ext: 'zip', mime: 'application/zip' })
    expect(await sniffFileType(zip, budget)).toBeUndefined()
    // Other formats cost nothing from it.
    expect((await sniffFileType(Buffer.from('%PDF-1.7\n'), budget))?.ext).toBe('pdf')
  })

  it('shares one scanned-bytes budget too', async () => {
    const budget = new SniffBudget({ zipBytes: 1000 })
    expect(await sniffFileType(zipOfEmptyEntries(100), budget)).toBeUndefined()
  })

  it('looks at the first 64 KiB only', async () => {
    const manifest = storedEntry('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'))
    const near = Buffer.concat([storedEntry('a', new Uint8Array(1024)), manifest])
    const far = Buffer.concat([storedEntry('a', new Uint8Array(70 * 1024)), manifest])
    expect((await sniffFileType(near))?.ext).toBe('jar')
    expect((await sniffFileType(far))?.ext).toBe('zip')
  })

  it('a file detected past the budget keeps the client extension as claimed', async () => {
    const file = new MultipartFile({
      fieldName: 'doc',
      clientName: 'report.docx',
      type: 'application/octet-stream',
      content: Buffer.from(zipOfEmptyEntries(10)),
    })
    await file.detectType(new SniffBudget({ zipEntries: 5 }))
    expect(file.typeSource).toBe('claimed')
    expect(file.extname).toBe('docx')
  })
})

describe('BodyParserMiddleware > multipart type detection', () => {
  function multipartCtx(files: Uint8Array[]): HttpContext {
    const raw: RawRequest = {
      method: 'POST',
      path: '/',
      query: '',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1' },
      body: '',
      multipart: {
        fields: [],
        files: files.map((content, i) => ({
          fieldName: `f${i}`,
          clientName: `f${i}.bin`,
          contentType: 'application/octet-stream',
          size: content.length,
          contentB64: Buffer.from(content).toString('base64'),
        })),
      },
    }
    return new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
  }

  it('hands the event loop back between files', async () => {
    const ctx = multipartCtx([zipOfEmptyEntries(5), zipOfEmptyEntries(5), zipOfEmptyEntries(5)])
    let turns = 0
    let detected: string[] = []
    const tick = (): void => {
      turns++
      if (turns < 100) setImmediate(tick)
    }
    setImmediate(tick)
    await new BodyParserMiddleware().handle(ctx, async () => {
      detected = Object.values(ctx.request.allFiles()).flatMap((f) =>
        f instanceof MultipartFile ? [f.extname] : [],
      )
    })
    expect(detected).toEqual(['zip', 'zip', 'zip'])
    expect(turns).toBeGreaterThanOrEqual(2)
  })

  it('bounds the ZIP work of the whole body: the files past the budget stay claimed', async () => {
    // 4096 entries per request: the fifth file of 1000 entries is past it.
    const ctx = multipartCtx(Array.from({ length: 5 }, () => zipOfEmptyEntries(1000)))
    const sources: string[] = []
    await new BodyParserMiddleware().handle(ctx, async () => {
      for (const file of Object.values(ctx.request.allFiles())) {
        if (file instanceof MultipartFile) sources.push(file.typeSource)
      }
    })
    expect(sources).toEqual(['detected', 'detected', 'detected', 'detected', 'claimed'])
  })
})

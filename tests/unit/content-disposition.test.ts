/**
 * The download filename went into a quoted header field unescaped, so a `"`
 * closed the field early and the rest was read as further parameters. A
 * non-ASCII name could not travel in that field at all (the header is Latin-1)
 * and reached the browser mangled.
 */
import { describe, expect, it } from 'vitest'
import { Response as ReamResponse } from '../../src/http/Response.js'

function dispositionFor(name: string): string {
  const res = new ReamResponse()
  // `attachment()` also reads the file; the header is set before that, so a
  // missing file still leaves the header behind.
  try {
    res.attachment('/nonexistent.bin', name)
  } catch {
    /* the read fails, the header is what this asserts */
  }
  return String(res.getHeader('Content-Disposition') ?? '')
}

describe('ream > Content-Disposition', () => {
  it('escapes a quote instead of letting it close the field', () => {
    const header = dispositionFor('evil".exe; x="')
    expect(header).toBe('attachment; filename="evil\\".exe; x=\\""')
  })

  it('escapes the escape character first', () => {
    expect(dispositionFor('back\\slash.txt')).toBe('attachment; filename="back\\\\slash.txt"')
  })

  it('adds the RFC 6266 extended form for a non-ASCII name', () => {
    const header = dispositionFor('rapport-échéance.pdf')
    // An ASCII fallback for clients that ignore filename*…
    expect(header).toContain('filename="rapport-_ch_ance.pdf"')
    // …and the real name, percent-encoded as UTF-8.
    expect(header).toContain("filename*=UTF-8''rapport-%C3%A9ch%C3%A9ance.pdf")
  })

  it('leaves an ordinary name alone', () => {
    expect(dispositionFor('report.pdf')).toBe('attachment; filename="report.pdf"')
  })
})

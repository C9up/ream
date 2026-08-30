/**
 * An allowlist that accepts a claimed type is not an allowlist.
 *
 * Magic-byte detection is what makes `extname` trustworthy, and when it finds
 * nothing both halves of what gets checked — the filename and the header —
 * came from the client.
 */
import { describe, expect, it } from 'vitest'
import { MultipartFile } from '../../src/bodyparser/MultipartFile.js'

/** A one-pixel PNG, signature included. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function upload(clientName: string, type: string, content: Buffer) {
  return new MultipartFile({ fieldName: 'avatar', clientName, type, content })
}

describe('ream > uploads > a type the bytes do not carry', () => {
  it('accepts a real image against an image allowlist', async () => {
    const file = upload('avatar.png', 'image/png', PNG)
    await file.detectType()

    expect(file.validate({ extnames: ['png', 'jpg'] })).toBe(true)
    expect(file.typeSource).toBe('detected')
  })

  it('refuses a script that calls itself an image', async () => {
    // The filename says png, the header says image/png, and the bytes say
    // neither. Both halves of the old check came from the client.
    const file = upload('avatar.png', 'image/png', Buffer.from('#!/bin/sh\nrm -rf /\n'))
    await file.detectType()

    expect(file.validate({ extnames: ['png', 'jpg'] })).toBe(false)
    expect(file.errors.join(' ')).toMatch(/claimed by the upload/)
    expect(file.typeSource).toBe('claimed')
  })

  it('refuses it whatever the header says, since the name matched', async () => {
    const file = upload('avatar.png', 'application/x-sh', Buffer.from('#!/bin/sh\n'))
    await file.detectType()

    expect(file.validate({ extnames: ['png'] })).toBe(false)
  })

  it('still accepts a format that has no signature to find', async () => {
    // `csv` carries none, so finding nothing is the normal case and says
    // nothing about the file. Refusing here would break every text upload.
    const file = upload('report.csv', 'text/csv', Buffer.from('a,b\n1,2\n'))
    await file.detectType()

    expect(file.validate({ extnames: ['csv', 'txt'] })).toBe(true)
  })

  it('accepts a mixed allowlist, because one member has no signature', async () => {
    const file = upload('notes.txt', 'text/plain', Buffer.from('hello'))
    await file.detectType()

    // `png` has a signature and `txt` does not, so the absence proves nothing.
    expect(file.validate({ extnames: ['png', 'txt'] })).toBe(true)
  })

  it('still refuses an extension that is not on the list at all', async () => {
    const file = upload('evil.sh', 'application/x-sh', Buffer.from('#!/bin/sh\n'))
    await file.detectType()

    expect(file.validate({ extnames: ['png'] })).toBe(false)
    expect(file.errors.join(' ')).toMatch(/not allowed/)
  })

  it('changes nothing when detection was never run', async () => {
    // `validate()` called standalone, without the middleware's detection pass:
    // there is nothing to conclude from, so the old behaviour stands.
    const file = upload('avatar.png', 'image/png', Buffer.from('#!/bin/sh\n'))

    expect(file.validate({ extnames: ['png'] })).toBe(true)
  })
})

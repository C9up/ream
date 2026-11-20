/**
 * Uploads used to be keyed by the literal part name, so the usual multi-file
 * markup `<input type="file" name="documents[]" multiple>` read with
 * `request.files('documents')` found nothing, and `user[avatar]` could not be
 * reached by path. `@adonisjs/bodyparser` 11.0.5 collects files with the same
 * bracket grammar as fields and reads them with `lodash.get`.
 */
import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { MultipartFile } from '../../src/bodyparser/MultipartFile.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'

function upload(fieldName: string, clientName: string) {
  return {
    fieldName,
    clientName,
    contentType: 'text/plain',
    size: 2,
    contentB64: Buffer.from('hi').toString('base64'),
  }
}

async function parsed(files: ReturnType<typeof upload>[]): Promise<HttpContext> {
  const raw: RawRequest = {
    method: 'POST',
    path: '/',
    query: '',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1' },
    body: '',
    multipart: { fields: [], files },
  }
  const ctx = new HttpContext('test', raw, {}, { pattern: '/', middleware: [] })
  await new BodyParserMiddleware().handle(ctx, async () => {})
  return ctx
}

describe('request.file() / files() > bracket and dot paths', () => {
  it('reads documents[] uploads with files("documents")', async () => {
    const ctx = await parsed([upload('documents[]', 'a.txt'), upload('documents[]', 'b.txt')])

    expect(ctx.request.files('documents').map((file) => file.clientName)).toEqual([
      'a.txt',
      'b.txt',
    ])
    expect(ctx.request.file('documents')?.clientName).toBe('a.txt')
  })

  it('reaches a nested upload by dot path', async () => {
    const ctx = await parsed([upload('user[avatar]', 'me.png')])

    expect(ctx.request.file('user.avatar')?.clientName).toBe('me.png')
    expect(ctx.request.files('user.avatar').map((file) => file.clientName)).toEqual(['me.png'])
  })

  it('orders explicitly indexed uploads by their index', async () => {
    const ctx = await parsed([
      upload('documents[1]', 'second.txt'),
      upload('documents[0]', 'first.txt'),
    ])

    expect(ctx.request.files('documents').map((file) => file.clientName)).toEqual([
      'first.txt',
      'second.txt',
    ])
    expect(ctx.request.file('documents[1]')?.clientName).toBe('second.txt')
  })

  it('collects a plain repeated name into a list', async () => {
    const ctx = await parsed([upload('photos', 'a.png'), upload('photos', 'b.png')])

    expect(ctx.request.files('photos')).toHaveLength(2)
    expect(ctx.request.file('photos')?.clientName).toBe('a.png')
  })

  it('returns the nested tree from allFiles()', async () => {
    const ctx = await parsed([upload('documents[]', 'a.txt'), upload('user[avatar]', 'me.png')])
    const all = ctx.request.allFiles()

    expect(Object.keys(all)).toEqual(['documents', 'user'])
    const documents = all.documents
    expect(Array.isArray(documents) && documents[0] instanceof MultipartFile).toBe(true)
    const user = all.user
    expect(typeof user === 'object' && user !== null && Reflect.get(user, 'avatar')).toBeInstanceOf(
      MultipartFile,
    )
  })

  it('answers null / [] for a path that holds no upload', async () => {
    const ctx = await parsed([upload('user[avatar]', 'me.png')])

    expect(ctx.request.file('user')).toBeNull()
    expect(ctx.request.files('user')).toEqual([])
    expect(ctx.request.file('missing')).toBeNull()
  })
})

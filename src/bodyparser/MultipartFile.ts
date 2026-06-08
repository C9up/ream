/**
 * MultipartFile — represents an uploaded file.
 *
 * Like AdonisJS MultipartFile:
 *   const avatar = request.file('avatar', { size: '2mb', extnames: ['jpg', 'png'] })
 *   await avatar.moveToDisk('uploads')
 */

import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

export interface FileValidationOptions {
  size?: string
  extnames?: string[]
}

export class MultipartFile {
  /** Original filename from the client. */
  readonly clientName: string

  /** File extension (without dot). */
  readonly extname: string

  /** MIME type from the Content-Type header. */
  readonly type: string

  /** File size in bytes. */
  readonly size: number

  /** Raw file content as Buffer. */
  readonly content: Buffer

  /** Field name in the form. */
  readonly fieldName: string

  /** Validation errors. */
  readonly errors: string[] = []

  /** Whether the file has been moved. */
  #moved = false

  constructor(options: {
    fieldName: string
    clientName: string
    type: string
    content: Buffer
  }) {
    this.fieldName = options.fieldName
    this.clientName = options.clientName
    this.type = options.type
    this.content = options.content
    this.size = options.content.length
    const segments = options.clientName.split('.')
    this.extname = segments.length > 1 ? (segments.at(-1) ?? '').toLowerCase() : ''
  }

  /** Validate file against size and extension rules. */
  validate(options: FileValidationOptions): boolean {
    if (options.size) {
      const maxBytes = parseFileSize(options.size)
      if (this.size > maxBytes) {
        this.errors.push(`File size ${this.size} exceeds limit ${options.size}`)
      }
    }
    if (options.extnames && options.extnames.length > 0) {
      if (!options.extnames.includes(this.extname)) {
        this.errors.push(
          `Extension '${this.extname}' not allowed. Allowed: ${options.extnames.join(', ')}`,
        )
      }
    }
    return this.errors.length === 0
  }

  get isValid(): boolean {
    return this.errors.length === 0
  }

  /**
   * Move file to a directory on disk. When `name` is supplied it must be
   * a plain filename — no path separators, no `.`/`..` segments. The
   * common footgun is passing the client-supplied `clientName` directly
   * (`await file.moveToDisk('uploads', file.clientName)`); a malicious
   * upload could otherwise traverse out of `directory` via `../../etc/...`.
   */
  async moveToDisk(directory: string, name?: string): Promise<string> {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    if (name !== undefined && !isSafeFilename(name)) {
      throw new Error(
        `MultipartFile.moveToDisk: 'name' must be a plain filename (no path separators, '.', or '..'). Got: ${JSON.stringify(name)}`,
      )
    }

    mkdirSync(directory, { recursive: true })
    const fileName = name ?? `${randomBytes(16).toString('hex')}.${this.extname}`
    // Defense-in-depth: the default branch interpolates `extname` (derived
    // from attacker-controlled `clientName`) into the filename, bypassing
    // the `name` guard above. Re-validate the synthesized fileName before
    // join to reject a hostile extname (separators, NUL).
    if (!isSafeFilename(fileName)) {
      throw new Error(
        `MultipartFile.moveToDisk: derived filename '${fileName}' is unsafe (separator or invalid char in clientName-derived extname).`,
      )
    }
    const filePath = join(directory, fileName)
    writeFileSync(filePath, this.content)
    this.#moved = true
    return filePath
  }

  get isMoved(): boolean {
    return this.#moved
  }

  /**
   * Return a fresh `Readable` over the file's bytes. The underlying buffer is
   * not consumed — repeated calls always start at byte 0, so callers can pipe
   * the same file into multiple sinks (e.g. validation hash + disk write)
   * without `Buffer.from(this.content)` boilerplate.
   */
  stream(): Readable {
    return Readable.from(this.content, { objectMode: false })
  }
}

function isSafeFilename(name: string): boolean {
  if (name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (/[\\/\0]/.test(name)) return false
  return true
}

function parseFileSize(size: string): number {
  const match = size.match(/^(\d+)(kb|mb|gb)?$/i)
  if (!match) return 1024 * 1024
  const num = parseInt(match[1], 10)
  switch (match[2]?.toLowerCase()) {
    case 'kb':
      return num * 1024
    case 'mb':
      return num * 1024 * 1024
    case 'gb':
      return num * 1024 * 1024 * 1024
    default:
      return num
  }
}

/**
 * Hydrate `MultipartFile` instances from the typed payload the Rust
 * HyperServer attaches to the request. The wire-level parser (multer crate,
 * see `crates/ream-http/src/multipart.rs`) handles the actual RFC 7578
 * parsing — JS just decodes the base64 envelope and wraps the result.
 */
export function hydrateMultipartPayload(payload: {
  fields: Array<{ name: string; value: string }>
  files: Array<{
    fieldName: string
    clientName: string
    contentType: string
    size: number
    contentB64: string
  }>
}): { fields: Record<string, string>; files: MultipartFile[] } {
  const fields: Record<string, string> = {}
  for (const field of payload.fields) {
    fields[field.name] = field.value
  }
  const files = payload.files.map(
    (f) =>
      new MultipartFile({
        fieldName: f.fieldName,
        clientName: f.clientName,
        type: f.contentType,
        content: Buffer.from(f.contentB64, 'base64'),
      }),
  )
  return { fields, files }
}

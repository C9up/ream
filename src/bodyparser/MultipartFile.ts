/**
 * MultipartFile — represents an uploaded file.
 *
 * Like AdonisJS MultipartFile:
 *   const avatar = request.file('avatar', { size: '2mb', extnames: ['jpg', 'png'] })
 *   await avatar.moveToDisk('uploads')
 */

import { randomBytes } from 'node:crypto'

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
  private moved = false

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
    this.extname = options.clientName.includes('.')
      ? options.clientName.split('.').pop()!.toLowerCase()
      : ''
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
        this.errors.push(`Extension '${this.extname}' not allowed. Allowed: ${options.extnames.join(', ')}`)
      }
    }
    return this.errors.length === 0
  }

  get isValid(): boolean {
    return this.errors.length === 0
  }

  /** Move file to a directory on disk. */
  async moveToDisk(directory: string, name?: string): Promise<string> {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    mkdirSync(directory, { recursive: true })
    const fileName = name ?? `${randomBytes(16).toString('hex')}.${this.extname}`
    const filePath = join(directory, fileName)
    writeFileSync(filePath, this.content)
    this.moved = true
    return filePath
  }

  get isMoved(): boolean {
    return this.moved
  }
}

function parseFileSize(size: string): number {
  const match = size.match(/^(\d+)(kb|mb|gb)?$/i)
  if (!match) return 1024 * 1024
  const num = parseInt(match[1], 10)
  switch (match[2]?.toLowerCase()) {
    case 'kb': return num * 1024
    case 'mb': return num * 1024 * 1024
    case 'gb': return num * 1024 * 1024 * 1024
    default: return num
  }
}

/**
 * Parse multipart body and extract files.
 * Returns field values and files separately.
 */
export function parseMultipartFiles(
  body: string,
  boundary: string,
): { fields: Record<string, string>; files: MultipartFile[] } {
  const fields: Record<string, string> = {}
  const files: MultipartFile[] = []

  const parts = body.split(`--${boundary}`)
  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue

    const headers = part.slice(0, headerEnd)
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, '')
    const nameMatch = headers.match(/name="([^"]+)"/)
    const filenameMatch = headers.match(/filename="([^"]*)"/)
    const contentTypeMatch = headers.match(/Content-Type:\s*(.+)/i)

    if (!nameMatch) continue

    if (filenameMatch && filenameMatch[1]) {
      files.push(new MultipartFile({
        fieldName: nameMatch[1],
        clientName: filenameMatch[1],
        type: contentTypeMatch?.[1]?.trim() ?? 'application/octet-stream',
        content: Buffer.from(value, 'binary'),
      }))
    } else {
      fields[nameMatch[1]] = value
    }
  }

  return { fields, files }
}

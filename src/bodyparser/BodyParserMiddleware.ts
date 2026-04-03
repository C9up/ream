/**
 * BodyParser middleware — parses request bodies by content-type.
 *
 * Supports JSON, form-urlencoded, and raw text.
 * Multipart (file uploads) handled separately.
 * Configured via config/bodyparser.ts.
 */

import type { HttpContext } from '../http/HttpContext.js'
import { parseMultipartFiles } from './MultipartFile.js'

export interface BodyParserConfig {
  json?: {
    enabled?: boolean
    limit?: string // e.g. '1mb'
    types?: string[]
  }
  form?: {
    enabled?: boolean
    limit?: string
    types?: string[]
  }
  raw?: {
    enabled?: boolean
    limit?: string
    types?: string[]
  }
  multipart?: {
    enabled?: boolean
    limit?: string
    maxFields?: number
    tmpDir?: string
    types?: string[]
  }
}

const DEFAULT_CONFIG: Required<BodyParserConfig> = {
  json: {
    enabled: true,
    limit: '1mb',
    types: ['application/json', 'application/vnd.api+json'],
  },
  form: {
    enabled: true,
    limit: '1mb',
    types: ['application/x-www-form-urlencoded'],
  },
  raw: {
    enabled: false,
    limit: '1mb',
    types: ['text/plain'],
  },
  multipart: {
    enabled: true,
    limit: '20mb',
    maxFields: 500,
    tmpDir: '/tmp',
    types: ['multipart/form-data'],
  },
}

export default class BodyParserMiddleware {
  private config: Required<BodyParserConfig>

  constructor(config?: BodyParserConfig) {
    this.config = {
      json: { ...DEFAULT_CONFIG.json, ...config?.json },
      form: { ...DEFAULT_CONFIG.form, ...config?.form },
      raw: { ...DEFAULT_CONFIG.raw, ...config?.raw },
      multipart: { ...DEFAULT_CONFIG.multipart, ...config?.multipart },
    }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const contentType = ctx.request.header('content-type') ?? ''
    const rawBody = ctx.request.raw()

    // Size check
    if (rawBody.length > parseSize(this.getLimit(contentType))) {
      ctx.response.status(413).json({
        error: { code: 'E_REQUEST_ENTITY_TOO_LARGE', message: 'Request body exceeds size limit' },
      })
      return
    }

    // JSON
    if (this.config.json.enabled && matchesType(contentType, this.config.json.types!)) {
      // Request already lazy-parses JSON — nothing to do
    }

    // Form URL-encoded
    if (this.config.form.enabled && matchesType(contentType, this.config.form.types!)) {
      ctx.request._setParsedBody(parseFormUrlEncoded(rawBody))
    }

    // Multipart — parse fields and files
    if (this.config.multipart.enabled && matchesType(contentType, this.config.multipart.types!)) {
      const boundary = extractBoundary(contentType)
      if (boundary) {
        const { fields, files } = parseMultipartFiles(rawBody, boundary)
        ctx.request._setParsedBody(fields)
        ctx.request._setFiles(files)
      }
    }

    await next()
  }

  private getLimit(contentType: string): string {
    if (matchesType(contentType, this.config.json.types!)) return this.config.json.limit!
    if (matchesType(contentType, this.config.form.types!)) return this.config.form.limit!
    if (matchesType(contentType, this.config.multipart.types!)) return this.config.multipart.limit!
    return this.config.raw.limit!
  }
}

function matchesType(contentType: string, types: string[]): boolean {
  return types.some((t) => contentType.includes(t))
}

function parseSize(size: string): number {
  const match = size.match(/^(\d+)(kb|mb|gb)?$/i)
  if (!match) return 1024 * 1024 // default 1mb
  const num = parseInt(match[1], 10)
  switch (match[2]?.toLowerCase()) {
    case 'kb': return num * 1024
    case 'mb': return num * 1024 * 1024
    case 'gb': return num * 1024 * 1024 * 1024
    default: return num
  }
}

function parseFormUrlEncoded(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!body) return result
  for (const pair of body.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      result[decodeURIComponent(pair)] = ''
    } else {
      result[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1))
    }
  }
  return result
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)
  return match?.[1] ?? match?.[2] ?? null
}

function parseMultipartFields(body: string, boundary: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const parts = body.split(`--${boundary}`)
  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers = part.slice(0, headerEnd)
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, '')
    const nameMatch = headers.match(/name="([^"]+)"/)
    if (nameMatch && !headers.includes('filename=')) {
      result[nameMatch[1]] = value
    }
    // File fields will be handled by the file upload middleware
  }
  return result
}

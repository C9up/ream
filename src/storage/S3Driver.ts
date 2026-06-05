/**
 * S3Driver — S3-compatible cloud storage (AWS S3, Cloudflare R2, MinIO).
 *
 * Uses fetch API — no external SDK dependency.
 * Implements the StorageDriver interface.
 *
 * @implements MISS-24
 */

import { createHash, createHmac } from 'node:crypto'
import type { StorageDriver } from './StorageManager.js'

/**
 * URI-encode an S3 object key for use in BOTH the request URL and the
 * SigV4 canonical path. Each `/`-delimited segment is percent-encoded
 * (so the slashes that delimit the key hierarchy survive), which means
 * spaces, `#`, `?`, `%` and non-ASCII bytes can't slip the requested
 * path away from the signed path — the classic "key with a space gets
 * a SignatureDoesNotMatch / 403, or `?`/`#` truncates the path" bug.
 *
 * S3 expects the canonical URI encoded ONCE (unlike the generic SigV4
 * double-encode), and `encodeURIComponent` already escapes the RFC 3986
 * sub-delims AWS cares about. We additionally escape `!`, `'`, `(`,
 * `)`, `*` which `encodeURIComponent` leaves untouched but AWS expects
 * percent-encoded.
 */
function encodeS3Key(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')
}

export interface S3Config {
  bucket: string
  region?: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  publicUrl?: string
}

export class S3Driver implements StorageDriver {
  #config: S3Config
  #endpoint: string

  constructor(config: S3Config) {
    this.#config = config
    this.#endpoint = config.endpoint ?? `https://s3.${config.region ?? 'us-east-1'}.amazonaws.com`
  }

  async put(filePath: string, content: Buffer | string): Promise<void> {
    const body = typeof content === 'string' ? Buffer.from(content) : content
    const key = encodeS3Key(filePath)
    const url = `${this.#endpoint}/${this.#config.bucket}/${key}`
    const headers = this.#signRequest('PUT', key, body)

    const res = await fetch(url, { method: 'PUT', headers, body: body as unknown as BodyInit })
    if (!res.ok) {
      throw new Error(`S3 PUT failed (${res.status}): ${await res.text()}`)
    }
  }

  async get(filePath: string): Promise<Buffer | null> {
    const key = encodeS3Key(filePath)
    const url = `${this.#endpoint}/${this.#config.bucket}/${key}`
    const headers = this.#signRequest('GET', key)

    const res = await fetch(url, { method: 'GET', headers })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`S3 GET failed (${res.status})`)

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  async delete(filePath: string): Promise<boolean> {
    const key = encodeS3Key(filePath)
    const url = `${this.#endpoint}/${this.#config.bucket}/${key}`
    const headers = this.#signRequest('DELETE', key)

    const res = await fetch(url, { method: 'DELETE', headers })
    return res.ok || res.status === 204
  }

  async exists(filePath: string): Promise<boolean> {
    const key = encodeS3Key(filePath)
    const url = `${this.#endpoint}/${this.#config.bucket}/${key}`
    const headers = this.#signRequest('HEAD', key)

    const res = await fetch(url, { method: 'HEAD', headers })
    return res.ok
  }

  url(filePath: string): string {
    const key = encodeS3Key(filePath)
    if (this.#config.publicUrl) {
      return `${this.#config.publicUrl}/${key}`
    }
    return `${this.#endpoint}/${this.#config.bucket}/${key}`
  }

  /**
   * Sign a request with AWS Signature V4 (simplified).
   * For production, consider using @aws-sdk/signature-v4 for full compliance.
   */
  #signRequest(method: string, key: string, body?: Buffer): Record<string, string> {
    const now = new Date()
    const dateStamp = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
    const shortDate = dateStamp.slice(0, 8)
    const region = this.#config.region ?? 'us-east-1'
    const service = 's3'

    const payloadHash = createHash('sha256')
      .update(body ?? '')
      .digest('hex')

    const headers: Record<string, string> = {
      host: new URL(this.#endpoint).host,
      'x-amz-date': dateStamp,
      'x-amz-content-sha256': payloadHash,
    }

    if (body) {
      headers['content-length'] = String(body.length)
    }

    // Canonical request
    const signedHeaders = Object.keys(headers).sort().join(';')
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}\n`)
      .join('')
    const canonicalRequest = [
      method,
      `/${this.#config.bucket}/${key}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    // String to sign
    const scope = `${shortDate}/${region}/${service}/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      dateStamp,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')

    // Signing key
    const kDate = createHmac('sha256', `AWS4${this.#config.secretAccessKey}`)
      .update(shortDate)
      .digest()
    const kRegion = createHmac('sha256', kDate).update(region).digest()
    const kService = createHmac('sha256', kRegion).update(service).digest()
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest()

    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.#config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    return headers
  }
}

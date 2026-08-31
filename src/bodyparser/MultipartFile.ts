/**
 * The top-level mime types IANA registers.
 *
 * Closed on purpose. Typing {@link MultipartFile.type} as a bare `string` let
 * `file.type === 'image/png'` compile and quietly never match — a mime filter
 * that passes everything, which is the shape a comment used to warn about and
 * a compiler can simply refuse. Against this union that comparison is an
 * error, and {@link MultipartFile.mime} is what a full-mime check wants.
 *
 * A top-level type outside this list is malformed: an unregistered format
 * belongs under one of these trees, `application/x-…` rather than `x-foo/bar`.
 *
 * Additive, not a replacement: {@link MultipartFile.type} keeps upstream's
 * `string` and its raw segment, and {@link MultipartFile.registeredType}
 * narrows it here for callers who want `=== 'image/png'` refused at compile
 * time. Nothing a valid AdonisJS call site does stops compiling, and no type
 * outside this set is swallowed — closing `type` itself would have done both.
 */
export type MimeType =
  | 'application'
  | 'audio'
  | 'example'
  | 'font'
  | 'image'
  | 'message'
  | 'model'
  | 'multipart'
  | 'text'
  | 'video'

const MIME_TYPES = new Set<string>([
  'application',
  'audio',
  'example',
  'font',
  'image',
  'message',
  'model',
  'multipart',
  'text',
  'video',
])

/** Whether a parsed top-level type is one IANA registers. */
function isMimeType(value: string): value is MimeType {
  return MIME_TYPES.has(value)
}

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

  /**
   * The PRIMARY mime type — `image` for `image/png`. Pair it with
   * {@link subtype}, as AdonisJS does.
   *
   * DERIVED FROM THE MAGIC BYTES when they can be read, and only from the
   * Content-Type header when they cannot — upstream's precedence, and the one
   * that matters: the header is written by the client, so a `.exe` announced as
   * `image/png` would otherwise sail through a mime allowlist. A renamed file
   * reports what it actually is.
   *
   * BREAKING as of 0.2.0: it used to hold the whole `image/png`. A comparison
   * against a full mime — `file.type === 'image/png'` — compiles and never
   * matches, which is what {@link mime} exists for, and what
   * {@link registeredType} refuses at compile time for callers who want that.
   *
   * `string` and the raw segment, as upstream: a type outside the registered
   * set is still reported rather than swallowed.
   */
  get type(): string | undefined {
    return this.#mimeParts()[0]
  }

  /**
   * The same primary type, narrowed to what IANA registers.
   *
   * Additive, and the point of it: against a closed union
   * `file.registeredType === 'image/png'` is a compile error instead of a
   * comparison that always fails. `undefined` where {@link type} holds
   * something outside the set — a malformed or unregistered tree — so the two
   * disagree exactly there and nowhere else.
   */
  get registeredType(): MimeType | undefined {
    const type = this.#mimeParts()[0]
    return type !== undefined && isMimeType(type) ? type : undefined
  }

  /** The mime SUBTYPE — `png` for `image/png`. Same source as {@link type}. */
  get subtype(): string | undefined {
    return this.#mimeParts()[1]
  }

  /**
   * The full mime to validate against — `image/png`.
   *
   * What an allowlist wants, and the reason this exists: splitting the mime for
   * upstream parity left every caller re-joining it by hand, and a caller that
   * forgot got a filter that silently matched nothing. Same trustworthy source
   * as {@link type}.
   */
  get mime(): string | undefined {
    const [type, subtype] = this.#mimeParts()
    if (!type) return undefined
    return subtype ? `${type}/${subtype}` : type
  }

  /** Split the trustworthy mime once, detected bytes first, header second. */
  #mimeParts(): [string | undefined, string | undefined] {
    const source = this.#detected?.mime ?? this.#headerMime
    if (!source) return [undefined, undefined]
    const [type, subtype] = source.split(';')[0].trim().split('/')
    return [type || undefined, subtype || undefined]
  }

  /**
   * The part's headers.
   *
   * NAMED CONSTRAINT — Rust's multipart parser forwards only the part's
   * content-type across the NAPI boundary today, so this carries that one
   * header rather than every header the client sent.
   */
  readonly headers: Record<string, string>

  /** Always true. Lets a value be told apart from a plain form field. */
  readonly isMultipartFile = true as const

  /** Where the file is in its life: idle, consumed, or moved to disk. */
  state: 'idle' | 'streaming' | 'consumed' | 'moved' = 'consumed'

  /** Absolute path the file was moved to, once it has been. */
  filePath?: string

  /** The name it was written under, once it has been moved. */
  fileName?: string

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

  /** Extension derived from the (attacker-controlled) client filename. */
  #clientExtname: string

  /** Rules set through `sizeLimit` / `allowedExtensions`, used by a bare `validate()`. */
  #validationOptions: FileValidationOptions = {}

  /** The Content-Type the client sent — attacker-controlled, the fallback only. */
  readonly #headerMime: string

  /** Magic-byte fingerprint — set by {@link detectType}; absent for content `file-type` can't detect (text: txt/csv/svg/json). */
  #detected?: { ext: string; mime: string }
  /** Whether the magic-byte pass has run, however it turned out. */
  #detectionRan = false

  constructor(options: {
    fieldName: string
    clientName: string
    type: string
    content: Buffer
  }) {
    this.fieldName = options.fieldName
    this.clientName = options.clientName
    this.headers = { 'content-type': options.type }
    this.#headerMime = options.type
    this.content = options.content
    this.size = options.content.length
    const segments = options.clientName.split('.')
    this.#clientExtname = segments.length > 1 ? (segments.at(-1) ?? '').toLowerCase() : ''
  }

  /**
   * Fingerprint the real file type from its magic bytes (via `file-type`), so
   * validation + storage don't trust the attacker-controlled filename/header.
   * Mirrors AdonisJS, which detects binary types this way. Call once after
   * construction (the BodyParser middleware does this for every uploaded file).
   * Content `file-type` can't fingerprint (text formats) leaves the client
   * extension in force — same fallback AdonisJS uses.
   */
  async detectType(): Promise<void> {
    const { fileTypeFromBuffer, supportedExtensions } = await import('file-type')
    detectableExtensions = supportedExtensions
    const result = await fileTypeFromBuffer(this.content)
    if (result) this.#detected = { ext: result.ext, mime: result.mime }
    this.#detectionRan = true
  }

  /**
   * Where {@link mime} and {@link extname} came from.
   *
   * `'detected'` means the bytes said so. `'claimed'` means they did not, and
   * what is reported is the filename and the header the client sent — which
   * the client chose.
   */
  get typeSource(): 'detected' | 'claimed' {
    return this.#detected ? 'detected' : 'claimed'
  }

  /**
   * Magic-byte-detected MIME type — TRUSTWORTHY (content-derived). `undefined`
   * for text formats `file-type` can't fingerprint. Use this, not {@link type}.
   */
  get detectedType(): string | undefined {
    return this.#detected?.mime
  }

  /**
   * File extension without the dot — the magic-byte-detected one when available
   * (defeats a renamed binary), else the client filename's extension.
   */
  get extname(): string {
    return this.#detected?.ext ?? this.#clientExtname
  }

  /** The size ceiling set through {@link sizeLimit}, if any. */
  get sizeLimit(): number | string | undefined {
    return this.#validationOptions.size
  }

  set sizeLimit(limit: number | string | undefined) {
    this.#validationOptions.size = typeof limit === 'number' ? String(limit) : limit
  }

  /** The extension allowlist set through {@link allowedExtensions}, if any. */
  get allowedExtensions(): string[] | undefined {
    return this.#validationOptions.extnames
  }

  set allowedExtensions(extensions: string[] | undefined) {
    this.#validationOptions.extnames = extensions
  }

  /** Whether validation turned anything up. The inverse of {@link isValid}. */
  get hasErrors(): boolean {
    return this.errors.length > 0
  }

  /**
   * Validate the file against size and extension rules.
   *
   * The argument is optional: called bare it uses whatever was set through
   * {@link sizeLimit} and {@link allowedExtensions}, which is how AdonisJS
   * spells it.
   */
  validate(options: FileValidationOptions = this.#validationOptions): boolean {
    if (options.size) {
      const maxBytes = parseFileSize(options.size)
      if (this.size > maxBytes) {
        this.errors.push(`File size ${this.size} exceeds limit ${options.size}`)
      }
    }
    if (options.extnames && options.extnames.length > 0) {
      // `this.extname` is the magic-byte-detected extension when available, so a
      // binary renamed `evil.png` is validated by its real type, not its name.
      if (!options.extnames.includes(this.extname)) {
        this.errors.push(
          `Extension '${this.extname}' not allowed. Allowed: ${options.extnames.join(', ')}`,
        )
      } else if (this.#claimsATypeItCannotBe(options.extnames)) {
        // Every allowed format carries a signature, and none was found — so the
        // bytes are definitively not one of them, whatever the name says. A
        // shell script uploaded as `avatar.png` with `Content-Type: image/png`
        // otherwise passes an image allowlist, because both halves of what was
        // checked came from the client.
        this.errors.push(
          `Extension '${this.extname}' is claimed by the upload, not found in its content. ` +
            `Every allowed format (${options.extnames.join(', ')}) has a signature, and this file carries none.`,
        )
      }
    }
    return this.errors.length === 0
  }

  /**
   * Whether refusing this upload is warranted on the strength of the allowlist
   * alone.
   *
   * Only when the magic-byte pass actually ran and found nothing, AND every
   * allowed extension is one it would have recognised. For a list that allows
   * `csv` or `txt`, finding nothing is the normal case and says nothing.
   */
  #claimsATypeItCannotBe(extnames: string[]): boolean {
    if (this.#detected || !this.#detectionRan) return false
    if (!detectableExtensions) return false
    return extnames.every((extension) => detectableExtensions?.has(extension))
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
    this.markAsMoved(fileName, filePath)
    return filePath
  }

  /**
   * Write the file into `location` (AdonisJS `move`).
   *
   * NAMED DEVIATION — upstream renames a temporary file it streamed to disk;
   * Ream holds the bytes in memory (`multipart.tmpDir` is refused at
   * construction), so this writes the buffer. There is therefore no
   * `E_MISSING_FILE_TMP_PATH`: there is no temporary file to be missing.
   *
   * `overwrite` defaults to true, as upstream. The generated name carries the
   * detected extension, and both it and a caller-supplied `name` go through the
   * same plain-filename guard {@link moveToDisk} uses — the common footgun is
   * passing `file.clientName` straight through.
   */
  async move(location: string, options?: { name?: string; overwrite?: boolean }): Promise<void> {
    const { mkdir, writeFile, access } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const name = options?.name ?? `${randomBytes(16).toString('hex')}.${this.extname || 'unknown'}`
    if (!isSafeFilename(name)) {
      throw new Error(
        `MultipartFile.move: 'name' must be a plain filename (no path separators, '.', or '..'). Got: ${JSON.stringify(name)}`,
      )
    }

    const filePath = join(location, name)
    if (options?.overwrite === false) {
      const exists = await access(filePath).then(
        () => true,
        () => false,
      )
      if (exists) {
        throw new Error(
          `"${name}" already exists at "${location}". Set "overwrite = true" to overwrite it`,
        )
      }
    }

    await mkdir(location, { recursive: true })
    await writeFile(filePath, this.content)
    this.markAsMoved(name, filePath)
  }

  /** Record that the file now lives on disk. */
  markAsMoved(fileName: string, filePath: string): void {
    this.fileName = fileName
    this.filePath = filePath
    this.state = 'moved'
    this.#moved = true
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

/**
 * The extensions `file-type` can recognise, captured on the first detection.
 *
 * Module-level because it is a property of the library, not of a file, and
 * because `validate()` is synchronous while reading it is not.
 */
let detectableExtensions: ReadonlySet<string> | undefined

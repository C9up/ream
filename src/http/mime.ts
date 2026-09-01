/**
 * Content types for a response, resolved here rather than pulled in.
 *
 * `response.type('txt')` has to become `text/plain; charset=utf-8`, which is a
 * lookup table and one charset rule — the same job `@c9up/archive` already
 * does in its own table, so the framework was carrying a dependency for work
 * the ecosystem already owned.
 *
 * The table covers what an HTTP response realistically sets. An extension it
 * does not know falls through to the caller's own string, which is exactly
 * what happened before for anything the package did not know either.
 */

/** Extension → type. No leading dot; lowercase. */
const TYPES: Record<string, string> = {
  // text
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  md: 'text/markdown',
  ics: 'text/calendar',
  vtt: 'text/vtt',
  // application
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  xml: 'application/xml',
  rss: 'application/rss+xml',
  atom: 'application/atom+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  wasm: 'application/wasm',
  bin: 'application/octet-stream',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  // The IANA name;  is the older spelling browsers also take.
  ico: 'image/vnd.microsoft.icon',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  // audio / video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  // fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  // documents
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
}

/**
 * Whether a type carries text and therefore wants a charset.
 *
 * `text/*` always, plus the structured application types that are text in
 * practice — `json`, `javascript`, `manifest+json`. `application/xml` does not:
 * XML declares its own encoding, and the package this replaces agrees.
 */
function wantsUtf8(type: string): boolean {
  if (type.startsWith('text/')) return true
  return (
    type === 'application/json' ||
    type === 'application/javascript' ||
    type === 'application/manifest+json' ||
    type.endsWith('+json')
  )
}

/** The type for a bare extension, or `undefined` when it is not one we know. */
export function lookupType(extension: string): string | undefined {
  const ext = extension.replace(/^.*\./, '').toLowerCase()
  return TYPES[ext]
}

/**
 * A full `Content-Type` for an extension or a type (`mime-types.contentType`).
 *
 * Returns `false` for something it cannot resolve, as the package did, so the
 * caller keeps its existing fallback rather than writing `content-type: false`.
 */
export function contentType(input: string): string | false {
  if (input.length === 0) return false
  // Already a type — possibly with parameters the caller set itself.
  const type = input.includes('/') ? input : lookupType(input)
  if (type === undefined) return false
  if (type.includes('charset=')) return type
  const base = type.split(';')[0].trim().toLowerCase()
  return wantsUtf8(base) ? `${type}; charset=utf-8` : type
}

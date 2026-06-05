/**
 * Parse a human-readable size string (e.g. '1mb', '512kb', '2gb') to bytes.
 * Single source of truth — used by both BodyParserMiddleware and MultipartFile.
 */
export function parseSize(size: string): number {
  const match = size.match(/^(\d+)(kb|mb|gb)?$/i)
  if (!match) return 1024 * 1024 // default 1mb
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

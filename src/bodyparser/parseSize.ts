import { E_BODYPARSER_INVALID_SIZE } from '../errors/codes.js'
import { parse } from '../helpers/bytes.js'

/**
 * Read a size limit (`'1mb'`, `'50 mb'`, `'1.5kb'`, `1024`) into bytes, with
 * the `bytes` grammar every size option of the body parser accepts.
 *
 * Throws on anything it cannot read, or on a negative size. A silent fallback
 * is what turned `limit: '50 mb'` into a 1 MB cap with no word: a limit the
 * application did not set is worse than a boot that refuses to start.
 */
export function parseSize(size: string | number): number {
  const bytes = parse(size)
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    throw new E_BODYPARSER_INVALID_SIZE([JSON.stringify(size)])
  }
  return bytes
}

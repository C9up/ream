/**
 * A caught value as the `NodeJS.ErrnoException` an error callback takes.
 *
 * `catch` binds `unknown`: an `Error` already is one (every field it adds is
 * optional), and anything else thrown is wrapped, so a callback never reads
 * `.code` or `.message` off a string.
 */
export function toErrnoException(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error))
}

/** The `code` of a caught system error (`ENOENT`, `MODULE_NOT_FOUND`…), if any. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

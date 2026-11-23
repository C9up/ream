/**
 * Where an error code is documented.
 */

/** Where the framework's documentation is served. */
export const DOCS_BASE_URL = 'https://reamjs.com'

/**
 * The documentation of an error code: its row in the error index, whose anchor
 * is the code in lower case with `-` for `_` (`E_ATLAS_QUERY_ERROR` →
 * `#e-atlas-query-error`).
 */
export function errorDocsUrl(code: string): string {
  return `${DOCS_BASE_URL}/en/reference/errors#${code.toLowerCase().replaceAll('_', '-')}`
}
